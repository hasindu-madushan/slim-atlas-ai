//! End-to-end tests for the Deno + happy-dom rendering path.
//!
//! These tests spin up a real Deno subprocess (via `DenoRenderer::render`,
//! `click`, `fill`, `submit`) against a wiremock HTTP server, and
//! verify that the page's external `<script src="...">` bundles are
//! actually fetched (via Deno's allowlisted `fetch`) and executed by
//! happy-dom.
//!
//! Gated `#[ignore]` because they require a Deno binary on the host
//! (PATH, the per-user cache, or auto-install). Run with:
//!
//!   cargo test --test tier2_render_integration -- --ignored --nocapture
//!
//! If Deno is not available, each test prints `[skip] no deno on host`
//! and passes silently. This is the same convention as
//! `tests/deno_runtime_integration.rs`.

use std::sync::Arc;

use reqwest::cookie::Jar;
use slim_atlas::config::{Config, DenoConfig, HttpConfig, SecurityConfig};
use slim_atlas::deno::DenoRenderer;
use slim_atlas::deno_runtime::DenoRuntime;
use slim_atlas::state::SecurityPolicy;
use url::Url;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Locate a Deno binary on the host. Returns `None` if none of
/// the resolution strategies find one (we don't auto-install here —
/// that has its own test in `deno_runtime_integration.rs`).
fn find_deno() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("DENO_PATH") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    which::which("deno").ok()
}

/// Build a DenoRenderer instance for the tests. Returns `None` if Deno
/// isn't on the host, in which case every test in this file
/// silently passes.
async fn maybe_renderer() -> Option<Arc<DenoRenderer>> {
    let deno = find_deno()?;
    let cfg = DenoConfig {
        deno_path: deno.to_string_lossy().to_string(),
        deno_version: "2.8.2".into(),
        script_path: "./deno/render.ts".into(),
        pool_size: 1,
        idle_timeout_secs: 30,
        render_timeout_ms: 10_000,
    };
    let runtime = Arc::new(DenoRuntime::new(Arc::new(cfg)));
    let security = Arc::new(SecurityPolicy::from(&SecurityConfig {
        allowed_hosts: vec![], // allow all (test-only)
        block_third_party_cookies: false,
    }));
    let renderer = DenoRenderer::new(runtime, security, HttpConfig::default()).ok()?;
    Some(Arc::new(renderer))
}

/// Cookie jar (empty) shared by the tests.
fn empty_jar() -> Arc<Jar> {
    Arc::new(Jar::default())
}

// =====================================================================
// 1. render: external `<script>` actually executes
// =====================================================================

#[tokio::test]
#[ignore]
async fn render_external_script_executes_inline() {
    let Some(renderer) = maybe_renderer().await else {
        eprintln!("[skip] no deno on host");
        return;
    };
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(
                    r#"<!doctype html>
<html><body>
<div id="app"></div>
<script>document.getElementById("app").textContent = "injected"</script>
</body></html>"#,
                ),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&server.uri()).unwrap();
    let jar = empty_jar();
    let result = renderer.render(&url, &jar, None, None).await.unwrap();
    assert!(
        result.html.contains("injected"),
        "inline script did not execute: {}",
        result.html
    );
}

// =====================================================================
// 2. render: external `<script src>` fetches and runs
// =====================================================================

#[tokio::test]
#[ignore]
async fn render_external_script_src_fetches_and_runs() {
    let Some(renderer) = maybe_renderer().await else {
        eprintln!("[skip] no deno on host");
        return;
    };
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/bundle.js"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/javascript")
                .set_body_string(
                    r#"document.getElementById("app").textContent = "from-external""#,
                ),
        )
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(
                    r#"<!doctype html>
<html><body>
<div id="app"></div>
<script src="/bundle.js"></script>
</body></html>"#,
                ),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&server.uri()).unwrap();
    let jar = empty_jar();
    let result = renderer.render(&url, &jar, None, None).await.unwrap();
    assert!(
        result.html.contains("from-external"),
        "external script did not execute: {}",
        result.html
    );
}

// =====================================================================
// 3. fill: types into an input
// =====================================================================

#[tokio::test]
#[ignore]
async fn fill_input_with_value() {
    let Some(renderer) = maybe_renderer().await else {
        eprintln!("[skip] no deno on host");
        return;
    };
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(
                    r#"<!doctype html>
<html><body>
<input id="name" type="text" />
</body></html>"#,
                ),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&server.uri()).unwrap();
    let jar = empty_jar();
    let result = renderer.render(&url, &jar, None, None).await.unwrap();
    let fill_result = renderer
        .fill(&url, &jar, &result.html, "#name", "hello")
        .await
        .unwrap();
    assert!(
        fill_result.html.contains("hello"),
        "fill did not update DOM: {}",
        fill_result.html
    );
}

// =====================================================================
// 4. submit: submits the first form
// =====================================================================

#[tokio::test]
#[ignore]
async fn submit_form_first_form_when_no_selector() {
    let Some(renderer) = maybe_renderer().await else {
        eprintln!("[skip] no deno on host");
        return;
    };
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(
                    r#"<!doctype html>
<html><body>
<form action="/target"><button type="submit">Go</button></form>
</body></html>"#,
                ),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&server.uri()).unwrap();
    let jar = empty_jar();
    let result = renderer.render(&url, &jar, None, None).await.unwrap();
    let submit_result = renderer
        .submit(&url, &jar, &result.html, None)
        .await
        .unwrap();
    assert!(
        submit_result.new_url.unwrap().contains("/target"),
        "submit did not resolve action URL"
    );
}

// =====================================================================
// 5. submit: submits with a specific form selector
// =====================================================================

#[tokio::test]
#[ignore]
async fn submit_form_get_action() {
    let Some(renderer) = maybe_renderer().await else {
        eprintln!("[skip] no deno on host");
        return;
    };
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(
                    r#"<!doctype html>
<html><body>
<form action="/first"><input name="a" value="1" /></form>
<form action="/second"><input name="b" value="2" /></form>
</body></html>"#,
                ),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&server.uri()).unwrap();
    let jar = empty_jar();
    let result = renderer.render(&url, &jar, None, None).await.unwrap();
    let submit_result = renderer
        .submit(&url, &jar, &result.html, Some("form:nth-of-type(2)"))
        .await
        .unwrap();
    assert!(
        submit_result.new_url.unwrap().contains("/second"),
        "submit did not target second form"
    );
}

// =====================================================================
// 6. click: dispatches click on a non-anchor element with JS handler
// =====================================================================

#[tokio::test]
#[ignore]
async fn click_through_external_button_handler() {
    let Some(renderer) = maybe_renderer().await else {
        eprintln!("[skip] no deno on host");
        return;
    };
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(
                    r#"<!doctype html>
<html><body>
<div id="app"></div>
<button id="btn">Click me</button>
<script>
document.getElementById("btn").addEventListener("click", function() {
    document.getElementById("app").textContent = "clicked";
});
</script>
</body></html>"#,
                ),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&server.uri()).unwrap();
    let jar = empty_jar();
    let result = renderer.render(&url, &jar, None, None).await.unwrap();
    assert!(result.html.contains("Click me"), "button not found");

    let click_result = renderer
        .click(&url, &jar, &result.html, "#btn", None, None)
        .await
        .unwrap();
    // The click doesn't navigate, so new_url should be None
    assert!(click_result.new_url.is_none());
}
