//! Named diagrams in memory, each optionally bound to a .mmd file. Every
//! change bumps the version and is broadcast so live views follow; a
//! bound file is written on change and polled for edits made elsewhere
//! (polling the path, not watching an inode, so editors that save by
//! renaming a temp file over it are seen too).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

pub const STARTER: &str = "flowchart TD\n    A[Start] --> B[End]\n";

#[derive(Clone, Debug)]
pub struct Doc {
    pub name: String,
    pub source: String,
    pub version: u64,
    pub file: Option<PathBuf>,
    /// "init" | "agent" | "file" | "browser:<client>"
    pub origin: String,
}

#[derive(Clone, Debug)]
pub struct Change {
    pub doc: Doc,
}

#[derive(Clone)]
pub struct Store {
    docs: Arc<Mutex<BTreeMap<String, Doc>>>,
    tx: broadcast::Sender<Change>,
}

/// Write via a temp file and rename, so the poller (or an editor) never
/// reads a half-written file.
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".flowmaid-tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// Same rule as the tools' `doc` argument.
pub fn valid_doc_name(name: &str) -> bool {
    (1..=64).contains(&name.len()) && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}

impl Store {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Store { docs: Arc::default(), tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Change> {
        self.tx.subscribe()
    }

    /// A diagram, created with the starter source if new.
    pub fn get(&self, name: &str) -> Doc {
        let mut docs = self.docs.lock().unwrap();
        docs.entry(name.to_string())
            .or_insert_with(|| Doc {
                name: name.to_string(),
                source: STARTER.into(),
                version: 1,
                file: None,
                origin: "init".into(),
            })
            .clone()
    }

    /// A diagram if it exists, without creating it.
    pub fn peek(&self, name: &str) -> Option<Doc> {
        self.docs.lock().unwrap().get(name).cloned()
    }

    pub fn list(&self) -> Vec<Doc> {
        self.docs.lock().unwrap().values().cloned().collect()
    }

    /// Replace a diagram's source; writes a bound file unless the change
    /// came from that file.
    pub fn set(&self, name: &str, source: &str, origin: &str) -> Doc {
        self.get(name);
        let d = {
            let mut docs = self.docs.lock().unwrap();
            let d = docs.get_mut(name).unwrap();
            if d.source == source {
                return d.clone();
            }
            d.source = source.to_string();
            d.version += 1;
            d.origin = origin.to_string();
            d.clone()
        };
        if let (Some(f), false) = (&d.file, origin == "file") {
            if let Err(e) = write_atomic(f, source) {
                eprintln!("flowmaid-mcp: write {} failed: {e}", f.display());
            }
        }
        let _ = self.tx.send(Change { doc: d.clone() });
        d
    }

    /// Replace the source only if it is still at `base` (a browser edit
    /// built on that version); Err(current) when someone changed it since.
    pub fn set_if(&self, name: &str, source: &str, origin: &str, base: Option<u64>) -> Result<Doc, Doc> {
        let cur = self.get(name);
        if base.is_some_and(|b| b != cur.version) {
            return Err(cur);
        }
        Ok(self.set(name, source, origin))
    }

    /// Bind a diagram to a file: load it (or create it from `create_with`
    /// / the current source). A failed bind changes nothing.
    pub fn bind(&self, name: &str, path: &Path, create_with: Option<&str>) -> Result<Doc, String> {
        let file = std::path::absolute(path).map_err(|e| e.to_string())?;
        let text = if file.exists() {
            std::fs::read_to_string(&file).map_err(|e| e.to_string())?
        } else {
            let text = create_with.map(String::from).unwrap_or_else(|| self.get(name).source);
            write_atomic(&file, &text).map_err(|e| e.to_string())?;
            text
        };
        self.get(name);
        self.docs.lock().unwrap().get_mut(name).unwrap().file = Some(file);
        Ok(self.set(name, &text, "file"))
    }

    /// Follow bound files: changes made by other programs flow in.
    pub fn spawn_file_poller(&self) {
        let store = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(400));
            loop {
                tick.tick().await;
                for d in store.list() {
                    let Some(f) = &d.file else { continue };
                    let Ok(text) = std::fs::read_to_string(f) else { continue };
                    if text != d.source {
                        store.set(&d.name, &text, "file");
                    }
                }
            }
        });
    }
}
