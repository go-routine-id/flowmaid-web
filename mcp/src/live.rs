//! A small local web server: the flowmaid playground (embedded in the
//! binary) plus a sync channel. Agent edits reach open pages over
//! Server-Sent Events; edits made in the page come back with a POST.
//! Bound to 127.0.0.1, and every sync request must carry the session
//! token from the URL, so other web pages cannot read or change diagrams.

use crate::store::{valid_doc_name, SetError, Store, MAX_SOURCE};
use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{header, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::convert::Infallible;
use std::hash::{BuildHasher, Hasher};
use std::sync::{Arc, Mutex};
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};

const INDEX: &str = include_str!("../../index.html");
const FLOWEDIT: &str = include_str!("../../flowedit.js");
const PKG_JS: &str = include_str!("../../pkg/flowmaid_web.js");
const PKG_WASM: &[u8] = include_bytes!("../../pkg/flowmaid_web_bg.wasm");
const LIVE_JS: &str = include_str!("../assets/live-client.js");
const MAX_BODY: usize = 1 << 20;

#[derive(Clone)]
pub struct Live {
    pub base: String,
    token: String,
    viewers: Arc<Mutex<HashMap<String, usize>>>,
}

impl Live {
    pub fn url(&self, doc: &str) -> String {
        format!("{}?doc={doc}&t={}", self.base, self.token)
    }
    pub fn viewers(&self, doc: &str) -> usize {
        self.viewers.lock().unwrap().get(doc).copied().unwrap_or(0)
    }
}

#[derive(Clone)]
struct App {
    store: Store,
    live: Live,
}

#[derive(Deserialize)]
struct Q {
    doc: Option<String>,
    t: Option<String>,
}

/// 128 random bits from the std hasher's per-process random keys (no RNG crate).
fn token() -> String {
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(i ^ std::process::id() as u64);
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

pub async fn start(store: Store) -> std::io::Result<Live> {
    let port: u16 = match std::env::var("FLOWMAID_PORT") {
        Ok(p) => p.parse().unwrap_or(7878),
        Err(_) => 7878,
    };
    let host = "127.0.0.1";
    // Take the requested port, or the next free one (any, for port 0).
    let mut p = port;
    let listener = loop {
        match tokio::net::TcpListener::bind((host, p)).await {
            Ok(l) => break l,
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && port != 0 && p < port.saturating_add(30) => p += 1,
            Err(e) => return Err(e),
        }
    };
    let addr = listener.local_addr()?;
    let live = Live { base: format!("http://{host}:{}/", addr.port()), token: token(), viewers: Arc::default() };
    let app = Router::new()
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/flowedit.js", get(|| async { js(FLOWEDIT) }))
        .route("/pkg/flowmaid_web.js", get(|| async { js(PKG_JS) }))
        .route("/pkg/flowmaid_web_bg.wasm", get(|| async { ([(header::CONTENT_TYPE, "application/wasm")], PKG_WASM) }))
        .route("/__live.js", get(|| async { js(LIVE_JS) }))
        .route("/__events", get(events))
        .route("/__source", post(source))
        .with_state(App { store, live: live.clone() });
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("flowmaid-mcp: live view stopped: {e}");
        }
    });
    Ok(live)
}

fn js(body: &'static str) -> Response {
    ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], body).into_response()
}

async fn index() -> Response {
    let page = INDEX.replacen("</body>", "<script type=\"module\" src=\"/__live.js\"></script>\n</body>", 1);
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8"), (header::CACHE_CONTROL, "no-store")], page).into_response()
}

/// The doc a sync request is for, once its token and name check out;
/// else the status to answer with.
fn authed(app: &App, q: &Q) -> Result<String, (StatusCode, &'static str)> {
    if q.t.as_deref() != Some(app.live.token.as_str()) {
        return Err((StatusCode::FORBIDDEN, "bad token"));
    }
    let doc = q.doc.clone().unwrap_or_else(|| "default".into());
    if !valid_doc_name(&doc) {
        return Err((StatusCode::BAD_REQUEST, "bad doc name"));
    }
    Ok(doc)
}

fn source_event(d: &crate::store::Doc) -> Event {
    let data = serde_json::json!({ "doc": d.name, "source": d.source, "version": d.version, "origin": d.origin });
    Event::default().event("source").data(data.to_string())
}

/// Counts a viewer for as long as its event stream lives.
struct Viewer {
    doc: String,
    map: Arc<Mutex<HashMap<String, usize>>>,
}

impl Drop for Viewer {
    fn drop(&mut self) {
        if let Some(n) = self.map.lock().unwrap().get_mut(&self.doc) {
            *n = n.saturating_sub(1);
        }
    }
}

async fn events(
    State(app): State<App>,
    Query(q): Query<Q>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, &'static str)> {
    let doc = authed(&app, &q)?;
    *app.live.viewers.lock().unwrap().entry(doc.clone()).or_default() += 1;
    let guard = Viewer { doc: doc.clone(), map: app.live.viewers.clone() };
    let first = tokio_stream::once(Ok(source_event(&app.store.get(&doc))));
    let name = doc.clone();
    let store = app.store.clone();
    let rest = BroadcastStream::new(app.store.subscribe()).filter_map(move |c| {
        let _keep = &guard;
        match c {
            Ok(c) if c.doc.name == name => Some(Ok(source_event(&c.doc))),
            Ok(_) => None,
            // Fell behind and missed changes: send where things stand now.
            Err(_) => Some(Ok(source_event(&store.get(&name)))),
        }
    });
    Ok(Sse::new(first.chain(rest)).keep_alive(KeepAlive::default()))
}

#[derive(Deserialize)]
struct Post {
    source: String,
    client: Option<String>,
    base: Option<u64>,
}

async fn source(State(app): State<App>, Query(q): Query<Q>, body: Bytes) -> Response {
    let doc = match authed(&app, &q) {
        Ok(d) => d,
        Err(r) => return r.into_response(),
    };
    if body.len() > MAX_BODY {
        return (StatusCode::PAYLOAD_TOO_LARGE, "too large").into_response();
    }
    let Ok(p) = serde_json::from_slice::<Post>(&body) else {
        return (StatusCode::BAD_REQUEST, "expected {source, client, base}").into_response();
    };
    if p.source.len() > MAX_SOURCE {
        return (StatusCode::PAYLOAD_TOO_LARGE, "source too large (max 200 kB)").into_response();
    }
    let client: String = p.client.unwrap_or_default().chars().take(32).collect();
    // Built on an older copy (the agent edited meanwhile): refuse rather
    // than silently undo that edit; the page gets the current copy over
    // SSE and says so.
    match app.store.set_if(&doc, &p.source, &format!("browser:{client}"), p.base) {
        Ok(d) => ([(header::CONTENT_TYPE, "application/json")], serde_json::json!({ "version": d.version }).to_string()).into_response(),
        Err(SetError::Stale(cur)) => (
            StatusCode::CONFLICT,
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::json!({ "version": cur.version }).to_string(),
        )
            .into_response(),
        Err(SetError::Write(e)) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}
