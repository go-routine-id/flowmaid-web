//! Derive the flowmaid engine version from Cargo.lock at build time,
//! so `engine_version()` can never drift from the crate actually
//! compiled into the wasm bundle (bug hunt: the hand-maintained
//! string sat at "0.4.0" through four engine releases).

fn main() {
    println!("cargo:rerun-if-changed=Cargo.lock");
    let lock = std::fs::read_to_string("Cargo.lock").unwrap_or_default();
    let mut version = String::from("unknown");
    let mut in_flowmaid = false;
    for line in lock.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            in_flowmaid = false;
        } else if line == "name = \"flowmaid\"" {
            in_flowmaid = true;
        } else if in_flowmaid && line.starts_with("version = ") {
            version = line
                .trim_start_matches("version = ")
                .trim_matches('"')
                .to_string();
            break;
        }
    }
    println!("cargo:rustc-env=FLOWMAID_VERSION={version}");
}
