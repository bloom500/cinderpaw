//! Embeds the local page (web-app/dist) into the binary: three fixed files.
//! A dev build without `bun run build` in web-app/ still compiles and serves
//! a page saying so; the release workflow builds web-app first and its smoke
//! test checks for the real page.
use std::path::{Path, PathBuf};

const PLACEHOLDER: &str = "<!doctype html><meta charset=utf-8><title>Cinderpaw</title>\
<p>This build of Cinderpaw has no web page. Build it with: cd web-app &amp;&amp; bun run build</p>";

fn main() {
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web-app/dist");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    println!("cargo:rerun-if-changed={}", dist.display());
    for name in ["index.html", "app.js", "app.css"] {
        let src = dist.join(name);
        println!("cargo:rerun-if-changed={}", src.display());
        let body = std::fs::read_to_string(&src)
            .unwrap_or_else(|_| if name == "index.html" { PLACEHOLDER.to_string() } else { String::new() });
        std::fs::write(out.join(name), body).unwrap();
    }
}
