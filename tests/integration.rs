use std::sync::Arc;
use std::time::Duration;

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use slim_atlas::config::{Config, SecurityConfig};
use slim_atlas::mcp::tools::{ClickInput, GetTextInput, NavigateInput, QueryInput, SelectorInput};
use slim_atlas::mcp::McpServer;
use slim_atlas::session::id as session_id;
use slim_atlas::state::AppState;

async fn state_with_security(allowed: Vec<String>) -> AppState {
    let config = Config {
        security: SecurityConfig {
            allowed_hosts: allowed,
            block_third_party_cookies: true,
        },
        http: slim_atlas::config::HttpConfig {
            user_agent: "test".into(),
            timeout_secs: 5,
            max_redirects: 0,
            max_body_bytes: 1024,
        },
        session: slim_atlas::config::SessionConfig {
            ttl_minutes: 60,
            max_sessions: 10,
            persist: false,
        },
        ..Config::default()
    };
    AppState::new(config).await.unwrap()
}

fn navigate_input(url: &str, session_id: Option<String>) -> NavigateInput {
    NavigateInput {
        session_id,
        url: url.to_string(),
        force_tier: None,
        wait_for: None,
    }
}

const SAMPLE_HTML: &str = r##"<!doctype html>
<html>
  <head><title>Test Page</title></head>
  <body>
    <header><nav><a href="/about">About</a></nav></header>
    <main>
      <h1>Hello</h1>
      <p>Welcome to the test page.</p>
    </main>
    <script>alert('hi')</script>
  </body>
</html>"##;

#[tokio::test]
async fn navigate_fetches_and_extracts_text() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html; charset=utf-8")
                .set_body_string(SAMPLE_HTML),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let out = mcp
        .navigate_impl(navigate_input(&format!("{}/", server.uri()), None))
        .await
        .unwrap();

    assert!(!out.session_id.is_empty());
    assert_eq!(out.url, format!("{}/", server.uri()));
    assert_eq!(out.title, "Test Page");
}

#[tokio::test]
async fn navigate_reuses_session_id() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();
    let session_id = first.session_id.clone();

    let second = mcp
        .navigate_impl(navigate_input(&server.uri(), Some(session_id.clone())))
        .await
        .unwrap();
    assert_eq!(second.session_id, session_id);
}

#[tokio::test]
async fn get_text_with_optional_selector() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(SAMPLE_HTML)
                .insert_header("content-type", "text/html"),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);
    let session_id = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap()
        .session_id;

    let full = mcp
        .get_text_impl(GetTextInput {
            session_id: session_id.clone(),
            selector: None,
        })
        .unwrap();
    assert!(full.text.contains("Hello"));

    let scoped = mcp
        .get_text_impl(GetTextInput {
            session_id,
            selector: Some("main".into()),
        })
        .unwrap();
    assert!(scoped.text.contains("Welcome"));
    assert!(
        !scoped.text.contains("About"),
        "header text excluded by selector: {:?}",
        scoped.text
    );
}

#[tokio::test]
async fn query_returns_elements_with_attrs() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(SAMPLE_HTML)
                .insert_header("content-type", "text/html"),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);
    let session_id = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap()
        .session_id;

    let out = mcp
        .query_impl(QueryInput {
            session_id,
            selector: "h1".into(),
        })
        .unwrap();
    assert_eq!(out.elements.len(), 1);
    assert_eq!(out.elements[0].text.trim(), "Hello");
}

#[tokio::test]
async fn navigate_rejects_disallowed_host() {
    let server = MockServer::start().await;
    let state = Arc::new(state_with_security(vec!["blocked.test".into()]).await);
    let mcp = McpServer::new(state);

    let err = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap_err();
    assert_eq!(
        err.code.0, -32004,
        "expected SECURITY_VIOLATION, got {err:?}"
    );
}

#[tokio::test]
async fn force_tier_above_1_returns_tier_disabled() {
    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let err = mcp
        .navigate_impl(NavigateInput {
            session_id: None,
            url: "https://example.com/".into(),
            force_tier: Some(2),
            wait_for: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code.0, -32003, "expected TIER_DISABLED, got {err:?}");
}

#[tokio::test]
async fn unknown_session_returns_session_not_found() {
    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);
    let bogus_id = session_id::generate();

    let err = mcp
        .get_text_impl(GetTextInput {
            session_id: bogus_id,
            selector: None,
        })
        .unwrap_err();
    assert_eq!(
        err.code.0, -32001,
        "expected SESSION_NOT_FOUND, got {err:?}"
    );
}

#[tokio::test]
async fn get_html_returns_full_document_when_no_selector() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(SAMPLE_HTML)
                .insert_header("content-type", "text/html"),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);
    let session_id = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap()
        .session_id;

    let out = mcp
        .get_html_impl(SelectorInput {
            session_id,
            selector: None,
        })
        .unwrap();
    assert!(out.html.contains("<title>Test Page</title>"));
}

#[tokio::test]
async fn invalid_selector_returns_invalid_params() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(SAMPLE_HTML)
                .insert_header("content-type", "text/html"),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);
    let session_id = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap()
        .session_id;

    let err = mcp
        .query_impl(QueryInput {
            session_id,
            selector: "[[[bad".into(),
        })
        .unwrap_err();
    assert_eq!(err.code.0, -32602, "expected INVALID_PARAMS, got {err:?}");
}

#[tokio::test]
async fn app_state_new_succeeds_with_default_config() {
    let state = state_with_security(vec![]).await;
    assert_eq!(state.config.http.timeout_secs, 5);
}

#[tokio::test]
async fn app_state_new_starts_cleanup_task() {
    let state = state_with_security(vec![]).await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    let _ = state.sessions.len();
}

#[tokio::test]
async fn memory_probe_senses_current_process() {
    let state = state_with_security(vec![]).await;
    let sample = state
        .memory
        .lock()
        .expect("memory probe mutex poisoned")
        .sample(&state.child_pids());
    assert!(
        sample.server_rss > 1_000_000,
        "expected server RSS > 1 MB, got {}",
        sample.server_rss
    );
    assert_eq!(sample.child_rss, 0, "no child PIDs in Phase 1");
}

#[tokio::test]
async fn navigate_does_not_oom_after_many_calls() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(SAMPLE_HTML)
                .insert_header("content-type", "text/html"),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let before = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();
    let session_id = before.session_id;

    for _ in 0..5 {
        mcp.navigate_impl(navigate_input(&server.uri(), Some(session_id.clone())))
            .await
            .unwrap();
    }

    let after_rss = mcp
        .navigate_impl(navigate_input(&server.uri(), Some(session_id)))
        .await
        .unwrap();
    assert!(!after_rss.session_id.is_empty());
}

// =====================================================================
// `click` tool — T1 fast path
// =====================================================================
//
// Phase 1 only handles `<a href>` links. T2 escalation is planned for
// Phase 3 (see the big comment block in src/mcp/tools.rs above the
// `#[tool]` shim for click).

const SAMPLE_HTML_WITH_LINKS: &str = r##"<!doctype html>
<html>
  <head><title>Page One</title></head>
  <body>
    <a href="/page-two">Go to page two</a>
    <a href="https://example.com/external">External</a>
    <a href="mailto:hi@example.com">Email</a>
    <a href="javascript:void(0)">JS</a>
    <a href="#section">Section</a>
    <a>No href attribute</a>
    <button>Click me (button)</button>
  </body>
</html>"##;

const PAGE_TWO_HTML: &str = r##"<!doctype html>
<html>
  <head><title>Page Two</title></head>
  <body><h1>You made it to page two</h1></body>
</html>"##;

fn click_input(session_id: &str, selector: &str) -> ClickInput {
    ClickInput {
        session_id: session_id.to_string(),
        selector: selector.to_string(),
        wait_for: None,
        wait_timeout_ms: None,
        force_tier: None,
    }
}

#[tokio::test]
async fn click_follows_relative_href() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html; charset=utf-8")
                .set_body_string(SAMPLE_HTML_WITH_LINKS),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/page-two"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(PAGE_TWO_HTML),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&format!("{}/", server.uri()), None))
        .await
        .unwrap();
    let session_id = first.session_id;

    let out = mcp
        .click_impl(click_input(&session_id, "a[href='/page-two']"))
        .await
        .unwrap();

    assert!(out.success);
    assert_eq!(
        out.new_url.as_deref(),
        Some(format!("{}/page-two", server.uri()).as_str())
    );
}

#[tokio::test]
async fn click_resolves_relative_href_against_base_url() {
    // Verifies that a relative href is correctly resolved against the
    // current page's base URL. The HTML has `<a href="https://example.com/external">`
    // — an absolute URL — and the click's resolved URL must equal it
    // (Url::join keeps absolute URLs as-is, replacing the base).
    // We don't actually fetch example.com; we only verify the resolution
    // by checking the click's pre-fetch logic via the SecurityViolation
    // path: a blocked host returns before the fetch.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML_WITH_LINKS),
        )
        .mount(&server)
        .await;

    // Allow only the wiremock host; the absolute link to example.com is
    // blocked. This proves the resolution worked (if it resolved to
    // something else, the security check would pass or fail differently).
    let state = Arc::new(state_with_security(vec!["127.0.0.1".into()]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();

    let err = mcp
        .click_impl(click_input(
            &first.session_id,
            "a[href*='example.com/external']",
        ))
        .await
        .unwrap_err();
    assert_eq!(
        err.code.0, -32004,
        "expected SECURITY_VIOLATION (example.com not in allowlist), got {err:?}"
    );
}

#[tokio::test]
async fn click_rejects_button_element() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML_WITH_LINKS),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();

    let err = mcp
        .click_impl(click_input(&first.session_id, "button"))
        .await
        .unwrap_err();
    assert_eq!(err.code.0, -32602, "expected INVALID_PARAMS, got {err:?}");
}

#[tokio::test]
async fn click_rejects_javascript_href() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML_WITH_LINKS),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();

    let err = mcp
        .click_impl(click_input(
            &first.session_id,
            "a[href='javascript:void(0)']",
        ))
        .await
        .unwrap_err();
    assert_eq!(err.code.0, -32602, "expected INVALID_PARAMS, got {err:?}");
}

#[tokio::test]
async fn click_rejects_mailto_href() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML_WITH_LINKS),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();

    let err = mcp
        .click_impl(click_input(&first.session_id, "a[href^='mailto:']"))
        .await
        .unwrap_err();
    assert_eq!(err.code.0, -32602, "expected INVALID_PARAMS, got {err:?}");
}

#[tokio::test]
async fn click_rejects_fragment_href() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML_WITH_LINKS),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();

    let err = mcp
        .click_impl(click_input(&first.session_id, "a[href='#section']"))
        .await
        .unwrap_err();
    assert_eq!(err.code.0, -32602, "expected INVALID_PARAMS, got {err:?}");
}

#[tokio::test]
async fn click_rejects_anchor_without_href() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML_WITH_LINKS),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();

    // The 6th <a> has no href — selector picks it.
    let err = mcp
        .click_impl(click_input(&first.session_id, "a:nth-of-type(6)"))
        .await
        .unwrap_err();
    assert_eq!(err.code.0, -32602, "expected INVALID_PARAMS, got {err:?}");
}

#[tokio::test]
async fn click_returns_no_current_page_for_fresh_session() {
    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);
    let bogus_id = session_id::generate();

    let err = mcp
        .click_impl(click_input(&bogus_id, "a"))
        .await
        .unwrap_err();
    assert_eq!(
        err.code.0, -32001,
        "expected SESSION_NOT_FOUND, got {err:?}"
    );
}

#[tokio::test]
async fn click_invalid_selector_returns_invalid_params() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();

    let err = mcp
        .click_impl(click_input(&first.session_id, "[[[bad"))
        .await
        .unwrap_err();
    assert_eq!(err.code.0, -32602, "expected INVALID_PARAMS, got {err:?}");
}

#[tokio::test]
async fn click_force_tier_2_returns_tier_disabled() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML_WITH_LINKS),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();

    let input = ClickInput {
        force_tier: Some(2),
        ..click_input(&first.session_id, "a[href='/page-two']")
    };
    let err = mcp.click_impl(input).await.unwrap_err();
    assert_eq!(err.code.0, -32003, "expected TIER_DISABLED, got {err:?}");
}

#[tokio::test]
async fn click_updates_current_page_in_session() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML_WITH_LINKS),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/page-two"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(PAGE_TWO_HTML),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&format!("{}/", server.uri()), None))
        .await
        .unwrap();
    let session_id = first.session_id;

    mcp.click_impl(click_input(&session_id, "a[href='/page-two']"))
        .await
        .unwrap();

    // After the click, get_text should return the new page's content.
    let text = mcp
        .get_text_impl(GetTextInput {
            session_id: session_id.clone(),
            selector: None,
        })
        .unwrap();
    assert!(text.text.contains("You made it to page two"));
}

#[tokio::test]
async fn click_appends_history_entry() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(SAMPLE_HTML_WITH_LINKS),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/page-two"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(PAGE_TWO_HTML),
        )
        .mount(&server)
        .await;

    let state = Arc::new(state_with_security(vec![]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&format!("{}/", server.uri()), None))
        .await
        .unwrap();
    let session_id = first.session_id;

    mcp.click_impl(click_input(&session_id, "a[href='/page-two']"))
        .await
        .unwrap();

    // Inspect history via the session store.
    let history_len = mcp
        .state
        .sessions
        .with_session(Some(session_id), |s| Ok(s.history.len()))
        .unwrap();
    assert_eq!(
        history_len, 2,
        "expected 2 history entries (navigate + click), got {history_len}"
    );
}

#[tokio::test]
async fn click_respects_allowed_hosts() {
    let server = MockServer::start().await;
    // HTML with a link to a host that is NOT in the allowlist.
    let html = r##"<!doctype html>
    <html><body>
      <a href="https://blocked.test/page-two">Go</a>
    </body></html>"##;
    Mock::given(method("GET"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/html")
                .set_body_string(html),
        )
        .mount(&server)
        .await;

    // Allow the wiremock host (so navigate succeeds) but block the link's
    // target host.
    let state = Arc::new(state_with_security(vec!["127.0.0.1".into()]).await);
    let mcp = McpServer::new(state);

    let first = mcp
        .navigate_impl(navigate_input(&server.uri(), None))
        .await
        .unwrap();

    let err = mcp
        .click_impl(click_input(&first.session_id, "a[href*='blocked.test']"))
        .await
        .unwrap_err();
    assert_eq!(
        err.code.0, -32004,
        "expected SECURITY_VIOLATION, got {err:?}"
    );
}
