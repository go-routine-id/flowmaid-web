//! flowmaid MCP server (stdio). Gives an agent tools to read, build,
//! edit and render Mermaid-style diagrams with the flowmaid engine, and
//! serves the flowmaid playground locally as a live view that stays in
//! sync both ways with what the agent sees.
//!
//! stdout belongs to the MCP protocol: log to stderr only.

mod engine;
mod live;
mod ops;
mod store;

use base64::Engine as _;
use live::Live;
use ops::{apply_ops, Op};
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, CustomNotification, ExperimentalCapabilities, Implementation, ProtocolVersion,
        ServerCapabilities, ServerConfig, ServerNotification,
    },
    schemars::{self, JsonSchema},
    tool, tool_handler, tool_router, ServerHandler, ServiceExt,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use store::{valid_doc_name, Doc, SetError, Store, MAX_SOURCE};

const INSTRUCTIONS: &str = "flowmaid renders Mermaid-style diagrams (flowchart/graph, erDiagram, classDiagram, \
sequenceDiagram, stateDiagram, pie, swimlane, …). Diagrams are named documents (default: \"default\"). Typical loop: \
get_diagram to learn node/edge ids, edit_diagram with a list of ops (flowcharts) or set_diagram with full Mermaid \
source (any type), then render_diagram to look at it. open_live_view opens the diagram in the user's browser; it \
stays in sync both ways, so the user may also edit it there. Call get_diagram again before editing if the user may \
have changed it (see changed_by / version). When the user points at something on the canvas (\"this node\", \"the \
selected ones\"), call get_selection. \
The user can also chat from the live view: when Claude Code loads this server as a channel, those messages arrive as \
<channel source=\"flowmaid\" doc=\"…\" selection=\"…\"> (selection is what was selected when they sent it, as JSON). \
Act on them with these tools, then answer with reply_chat, passing the same doc.";

#[derive(Clone)]
struct Flowmaid {
    store: Store,
    live: Option<Live>,
    tool_router: ToolRouter<Self>,
}

#[derive(Deserialize, JsonSchema)]
struct DocArg {
    /// Diagram name (default "default"). Each name is a separate document.
    doc: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct SetArgs {
    /// Full Mermaid source, e.g. "flowchart TD\n  A[Start] --> B{OK?}"
    source: String,
    /// Diagram name (default "default").
    doc: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct EditArgs {
    /// Edits, applied in order, all-or-nothing.
    ops: Vec<Op>,
    /// Diagram name (default "default").
    doc: Option<String>,
}

#[derive(Deserialize, JsonSchema, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Format {
    Png,
    Svg,
}

#[derive(Deserialize, JsonSchema)]
struct RenderArgs {
    /// Diagram name (default "default").
    doc: Option<String>,
    /// Render this source instead of a stored document.
    source: Option<String>,
    /// png (default) or svg.
    format: Option<Format>,
    /// PNG scale, 0.5–4 (default 2).
    scale: Option<f32>,
}

#[derive(Deserialize, JsonSchema)]
struct LiveArgs {
    /// Diagram name (default "default").
    doc: Option<String>,
    /// Launch the browser (default true); false just returns the URL.
    open: Option<bool>,
}

#[derive(Deserialize, JsonSchema)]
struct ReplyArgs {
    /// The doc the chat message came from (its `doc` attribute).
    doc: String,
    /// Your answer, shown in the live view's chat.
    text: String,
}

#[derive(Deserialize, JsonSchema)]
struct FileArgs {
    /// Path of the .mmd file (absolute, or relative to the server's working directory).
    path: String,
    /// Diagram name (default "default").
    doc: Option<String>,
    /// Initial source when the file does not exist yet.
    create_with: Option<String>,
}

fn text(v: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(v.into())])
}

fn json_result(v: &Value) -> CallToolResult {
    text(serde_json::to_string_pretty(v).unwrap_or_default())
}

fn fail(msg: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(msg.into())])
}

fn doc_name(doc: &Option<String>) -> Result<String, CallToolResult> {
    let d = doc.clone().unwrap_or_else(|| "default".into());
    if valid_doc_name(&d) {
        Ok(d)
    } else {
        Err(fail(format!("Bad doc name \"{d}\": use 1–64 letters, digits, _ . -")))
    }
}

/// The live view's selection for a doc, as tools report it.
fn selection_json(live: &Live, doc: &str) -> Value {
    match live.selection(doc) {
        Some(s) => json!({ "selected": s.selection, "version": s.version, "at_unix_ms": s.at as u64 }),
        None => json!({ "selected": null }),
    }
}

#[tool_router]
impl Flowmaid {
    fn new(store: Store, live: Option<Live>) -> Self {
        Flowmaid { store, live, tool_router: Self::tool_router() }
    }

    fn snapshot(&self, d: &Doc) -> Value {
        let mut m = Map::new();
        m.insert("doc".into(), json!(d.name));
        m.insert("version".into(), json!(d.version));
        let by = if d.origin.starts_with("browser") { "user (live view)" } else { d.origin.as_str() };
        m.insert("changed_by".into(), json!(by));
        if let Some(f) = &d.file {
            m.insert("file".into(), json!(f.display().to_string()));
        }
        if let Some(l) = &self.live {
            m.insert("live_url".into(), json!(l.url(&d.name)));
            m.insert("live_viewers".into(), json!(l.viewers(&d.name)));
            m.insert("selection".into(), selection_json(l, &d.name));
        }
        m.insert("source".into(), json!(d.source));
        m.extend(engine::describe(&d.source));
        Value::Object(m)
    }

    /// Read access: the doc must exist, except "default" which always does.
    fn existing(&self, doc: &Option<String>) -> Result<Doc, CallToolResult> {
        let name = doc_name(doc)?;
        match self.store.peek(&name) {
            Some(d) => Ok(d),
            None if name == "default" => Ok(self.store.get(&name)),
            None => Err(fail(format!("No diagram named \"{name}\" yet; set_diagram or open_live_view creates it."))),
        }
    }

    #[tool(
        description = "Read a diagram: its Mermaid source plus parsed nodes (id, label, shape, fill, group), edges (from, to, nth, label, style) and groups, the live view URL and who changed it last. Use the ids from here in edit_diagram.",
        annotations(read_only_hint = true)
    )]
    async fn get_diagram(&self, Parameters(a): Parameters<DocArg>) -> CallToolResult {
        match self.existing(&a.doc) {
            Ok(d) => json_result(&self.snapshot(&d)),
            Err(e) => e,
        }
    }

    #[tool(
        description = "What the user has selected on the live view canvas right now: a node ({type: node, id}), several nodes ({type: nodes, ids}) or an edge ({type: edge, from, to, nth}), or null. Use it when the user says \"this node\" or \"the selected ones\". Selecting needs edit mode on in the page (flowcharts). `version` is the diagram version the page showed; if it is older than get_diagram's, the ids may be stale.",
        annotations(read_only_hint = true)
    )]
    async fn get_selection(&self, Parameters(a): Parameters<DocArg>) -> CallToolResult {
        let Some(live) = &self.live else {
            return fail("The live view server could not start (see the server's stderr).");
        };
        let d = match self.existing(&a.doc) {
            Ok(d) => d,
            Err(e) => return e,
        };
        let mut v = selection_json(live, &d.name);
        let m = v.as_object_mut().unwrap();
        m.insert("doc".into(), json!(d.name));
        m.insert("diagram_version".into(), json!(d.version));
        m.insert("live_viewers".into(), json!(live.viewers(&d.name)));
        json_result(&v)
    }

    #[tool(
        description = "Answer a chat message the user sent from the live view (it arrived as a flowmaid channel message): the text appears in the chat panel of the pages showing that doc. Keep it short; the diagram itself shows what you changed."
    )]
    async fn reply_chat(&self, Parameters(a): Parameters<ReplyArgs>) -> CallToolResult {
        let Some(live) = &self.live else {
            return fail("The live view server could not start (see the server's stderr).");
        };
        let name = match doc_name(&Some(a.doc)) {
            Ok(n) => n,
            Err(e) => return e,
        };
        if a.text.trim().is_empty() {
            return fail("Give some text.");
        }
        if live.reply(&name, &a.text) {
            text("Shown in the live view.")
        } else {
            text("No live view is open on this doc right now; the reply was not shown.")
        }
    }

    #[tool(
        description = "Replace a diagram's whole Mermaid source (any diagram type). The source is checked with the engine first; on a parse error nothing changes and the line-numbered error is returned. Open live views update immediately."
    )]
    async fn set_diagram(&self, Parameters(a): Parameters<SetArgs>) -> CallToolResult {
        let name = match doc_name(&a.doc) {
            Ok(n) => n,
            Err(e) => return e,
        };
        if a.source.len() > MAX_SOURCE {
            return fail("Source too large (max 200 kB).");
        }
        if let Some(e) = engine::parse_error(&a.source) {
            return fail(format!("Not changed, the source does not parse: {e}"));
        }
        match self.store.set(&name, &a.source, "agent") {
            Ok(d) => json_result(&self.snapshot(&d)),
            Err(e) => fail(format!("Not changed: {e}")),
        }
    }

    #[tool(
        description = "Apply a list of edits to a flowchart, in order and all-or-nothing: add_node, rename_node, delete_node, connect, update_edge, delete_edge, set_shape, set_color, group, ungroup. Only the touched lines of the Mermaid source are rewritten. Returns the new state, including ids created by add_node / group. Open live views update immediately."
    )]
    async fn edit_diagram(&self, Parameters(a): Parameters<EditArgs>) -> CallToolResult {
        // Like the read tools: a mistyped name is an error, not a new diagram.
        let name = match self.existing(&a.doc) {
            Ok(d) => d.name,
            Err(e) => return e,
        };
        if a.ops.is_empty() {
            return fail("Give at least one op.");
        }
        // Apply to the version read, and store only if it is still current:
        // a user editing in the live view meanwhile is not overwritten.
        // Ops name nodes by id, so re-applying them to the newer text is
        // what the agent meant; a few attempts cover a busy typist.
        for _ in 0..5 {
            let d = self.store.get(&name);
            let (src, created) = match apply_ops(&d.source, &a.ops) {
                Ok(r) => r,
                Err(e) => return fail(format!("Nothing changed: {e}")),
            };
            if src.len() > MAX_SOURCE {
                return fail("Nothing changed: the result would exceed 200 kB.");
            }
            match self.store.set_if(&name, &src, "agent", Some(d.version)) {
                Ok(d) => {
                    let mut v = self.snapshot(&d);
                    v.as_object_mut().unwrap().insert("created".into(), json!(created));
                    return json_result(&v);
                }
                Err(SetError::Write(e)) => return fail(format!("Nothing changed: {e}")),
                Err(SetError::Stale(_)) => {}
            }
        }
        fail("Nothing changed: the diagram kept changing under the edit (the user is editing it); call get_diagram and try again.")
    }

    #[tool(
        description = "Render a diagram to look at it: PNG (default) or SVG markup. Renders the named document, or `source` if given (without storing it).",
        annotations(read_only_hint = true)
    )]
    async fn render_diagram(&self, Parameters(a): Parameters<RenderArgs>) -> CallToolResult {
        let src = match &a.source {
            Some(s) if s.len() > MAX_SOURCE => return fail("Source too large (max 200 kB)."),
            Some(s) => s.clone(),
            None => match self.existing(&a.doc) {
                Ok(d) => d.source,
                Err(e) => return e,
            },
        };
        let svg = match engine::render_svg(&src) {
            Ok(s) => s,
            Err(e) => return fail(e),
        };
        if a.format == Some(Format::Svg) {
            return text(svg);
        }
        let scale = a.scale.unwrap_or(2.0).clamp(0.5, 4.0);
        match engine::render_png(&svg, scale) {
            Ok(png) => CallToolResult::success(vec![ContentBlock::image(
                base64::engine::general_purpose::STANDARD.encode(png),
                "image/png",
            )]),
            Err(e) => fail(format!("PNG rendering failed ({e}); ask for format \"svg\" instead.")),
        }
    }

    #[tool(
        description = "Open the diagram in the flowmaid playground in the user's browser. The page stays in sync both ways: your edits show up there at once, and the user's edits on the canvas or in the code panel come back (check get_diagram). Returns the URL so you can share it."
    )]
    async fn open_live_view(&self, Parameters(a): Parameters<LiveArgs>) -> CallToolResult {
        let Some(live) = &self.live else {
            return fail("The live view server could not start (see the server's stderr).");
        };
        let name = match doc_name(&a.doc) {
            Ok(n) => n,
            Err(e) => return e,
        };
        self.store.get(&name);
        let url = live.url(&name);
        let open = a.open.unwrap_or(true);
        if open {
            open_browser(&url);
        }
        json_result(&json!({ "url": url, "doc": name, "opened": open }))
    }

    #[tool(
        description = "Bind a diagram to a .mmd file on disk: its content is loaded (or the file is created), every later edit is written back, and changes made to the file by others flow in (and on to live views)."
    )]
    async fn open_file(&self, Parameters(a): Parameters<FileArgs>) -> CallToolResult {
        let name = match doc_name(&a.doc) {
            Ok(n) => n,
            Err(e) => return e,
        };
        if let Some(c) = &a.create_with {
            if let Some(e) = engine::parse_error(c) {
                return fail(format!("create_with does not parse: {e}"));
            }
        }
        match self.store.bind(&name, std::path::Path::new(&a.path), a.create_with.as_deref()) {
            Ok(d) => json_result(&self.snapshot(&d)),
            Err(e) => fail(format!("Could not open {}: {e}", a.path)),
        }
    }

    #[tool(
        description = "List the diagram documents in this session with their type, version, bound file and live URL.",
        annotations(read_only_hint = true)
    )]
    async fn list_diagrams(&self) -> CallToolResult {
        let diagrams: Vec<Value> = self
            .store
            .list()
            .iter()
            .map(|d| {
                let mut m = Map::new();
                m.insert("doc".into(), json!(d.name));
                m.insert("version".into(), json!(d.version));
                m.insert("type".into(), json!(engine::diagram_type(&d.source)));
                if let Some(f) = &d.file {
                    m.insert("file".into(), json!(f.display().to_string()));
                }
                if let Some(l) = &self.live {
                    m.insert("live_url".into(), json!(l.url(&d.name)));
                }
                Value::Object(m)
            })
            .collect();
        json_result(&json!({ "engine": flowmaid_web::engine_version(), "diagrams": diagrams }))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Flowmaid {
    fn get_info(&self) -> ServerConfig {
        // `claude/channel`: Claude Code may load this server as a channel,
        // so chat typed in the live view reaches the session.
        let mut experimental = ExperimentalCapabilities::new();
        experimental.insert("claude/channel".into(), Default::default());
        ServerConfig::new(ServerCapabilities::builder().enable_experimental_with(experimental).enable_tools().build())
            .with_protocol_version(ProtocolVersion::LATEST_WITH_INITIALIZE)
            .with_server_info(Implementation::new("flowmaid", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }

    // Claude Code registers channels only on the initialize handshake,
    // which protocol 2026-07-28 dropped: stay on the last one that has it.
    fn supported_protocol_versions(&self) -> std::borrow::Cow<'static, [ProtocolVersion]> {
        let v = ProtocolVersion::KNOWN_VERSIONS;
        std::borrow::Cow::Borrowed(&v[..v.iter().position(|p| *p == ProtocolVersion::LATEST_WITH_INITIALIZE).unwrap() + 1])
    }
}

fn open_browser(url: &str) {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/c", "start", "", url]);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    let _ = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("flowmaid-mcp {} (flowmaid engine {})", env!("CARGO_PKG_VERSION"), flowmaid_web::engine_version());
        return;
    }
    let store = Store::new();
    store.spawn_file_poller();
    let (live, chat_rx) = match live::start(store.clone()).await {
        Ok((l, rx)) => {
            eprintln!("flowmaid-mcp: live view at {}", l.url("default"));
            (Some(l), Some(rx))
        }
        Err(e) => {
            eprintln!("flowmaid-mcp: live view unavailable: {e}");
            (None, None)
        }
    };
    let server = match Flowmaid::new(store, live).serve(rmcp::transport::stdio()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("flowmaid-mcp: {e}");
            std::process::exit(1);
        }
    };
    if let Some(mut rx) = chat_rx {
        let peer = server.peer().clone();
        tokio::spawn(async move {
            while let Some(m) = rx.recv().await {
                let mut meta = Map::new();
                meta.insert("doc".into(), json!(m.doc));
                if let Some(sel) = &m.selection {
                    meta.insert("selection".into(), json!(serde_json::to_string(sel).unwrap_or_default()));
                }
                let params = json!({ "content": m.text, "meta": meta });
                let n = CustomNotification::new("notifications/claude/channel", Some(params));
                if let Err(e) = peer.send_notification(ServerNotification::CustomNotification(n)).await {
                    eprintln!("flowmaid-mcp: chat not delivered: {e}");
                }
            }
        });
    }
    let _ = server.waiting().await;
    // The live view would keep the process alive; a stdio server ends
    // with its client.
    std::process::exit(0);
}
