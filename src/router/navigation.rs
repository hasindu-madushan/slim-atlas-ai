//! Navigate and click orchestration. All requests go through Deno
//! for full JavaScript support.

use std::time::{Duration, Instant};

use url::Url;

use crate::error::{BrowserError, Result};
use crate::session::{CurrentPage, HistoryEntry};
use crate::state::AppState;
use crate::deno::framework::FrameworkHint;
use crate::deno::renderer::PageResult;

/// The result of a navigate operation.
#[derive(Debug, Clone)]
pub struct NavigateResult {
    pub url: String,
    pub title: String,
    pub html: String,
    pub text: String,
    pub framework: Option<FrameworkHint>,
    pub elapsed: Duration,
}

impl NavigateResult {
    fn from_page(page: PageResult, elapsed: Duration) -> Self {
        let url = page.new_url.clone().unwrap_or_else(|| page.url.clone());
        Self {
            url,
            title: page.title,
            html: page.html,
            text: page.text,
            framework: page.framework,
            elapsed,
        }
    }
}

/// Navigate to a URL using Deno for rendering.
pub async fn navigate(
    state: &AppState,
    session_id: &str,
    url: &Url,
    wait_for: Option<&str>,
    wait_timeout_ms: Option<u64>,
) -> Result<NavigateResult> {
    state.security.assert_host_allowed(url)?;

    let started = Instant::now();
    let cookies = state
        .sessions
        .with_session(Some(session_id.to_string()), |s| Ok(s.cookies.jar()))?;

    let renderer = state.renderer()?;
    let result = renderer
        .render(url, &cookies, wait_for, wait_timeout_ms)
        .await?;
    let elapsed = started.elapsed();
    let nav = NavigateResult::from_page(result, elapsed);
    let framework = nav.framework.clone().unwrap_or(FrameworkHint::Static);
    commit_navigate(state, session_id, &nav, framework)?;
    Ok(nav)
}

/// The result of a click operation.
#[derive(Debug, Clone)]
pub struct ClickResult {
    pub new_url: Option<String>,
    pub elapsed: Duration,
}

/// Click an element on the current page using Deno.
pub async fn click(
    state: &AppState,
    session_id: &str,
    selector: &str,
    wait_for: Option<&str>,
    wait_timeout_ms: Option<u64>,
) -> Result<ClickResult> {
    let started = Instant::now();

    // Read session state: current URL + HTML + cookies.
    let (current_url, current_html, cookies) =
        state
            .sessions
            .with_session(Some(session_id.to_string()), |s| {
                let page = s.current_page.as_ref().ok_or(BrowserError::NoCurrentPage)?;
                Ok((page.url.clone(), page.html.clone(), s.cookies.jar()))
            })?;

    let renderer = state.renderer()?;
    let url = Url::parse(&current_url).map_err(BrowserError::Url)?;
    state.security.assert_host_allowed(&url)?;
    let result = renderer
        .click(
            &url,
            &cookies,
            &current_html,
            selector,
            wait_for,
            wait_timeout_ms,
        )
        .await?;
    let elapsed = started.elapsed();
    let new_url = result.new_url.clone();
    let framework = result.framework.clone();
    let nav = NavigateResult::from_page(result, elapsed);
    let final_url = nav.url.clone();
    let committed_framework = framework.unwrap_or(FrameworkHint::Static);
    commit_navigate(state, session_id, &nav, committed_framework)?;
    Ok(ClickResult {
        new_url: new_url.or(Some(final_url)),
        elapsed,
    })
}

fn commit_navigate(
    state: &AppState,
    session_id: &str,
    result: &NavigateResult,
    framework: FrameworkHint,
) -> Result<()> {
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let entry = HistoryEntry {
        url: result.url.clone(),
        title: result.title.clone(),
        timestamp_ms,
    };
    let url = result.url.clone();
    let title = result.title.clone();
    let text = result.text.clone();
    let html = result.html.clone();
    let framework_for_commit = framework.clone();

    state
        .sessions
        .with_session(Some(session_id.to_string()), move |s| {
            s.history.push(entry);
            s.current_page = Some(CurrentPage {
                url,
                title,
                text,
                html,
                framework: Some(framework_for_commit.clone()),
            });
            s.last_framework_hint = Some(framework_for_commit);
            s.touch();
            Ok(())
        })?;
    Ok(())
}

/// Commit a `PageResult` (fill / submit) to the session without
/// pushing a history entry.
pub fn commit_for_fill(state: &AppState, session_id: &str, page: &PageResult) -> Result<()> {
    let url = page.url.clone();
    let title = page.title.clone();
    let text = page.text.clone();
    let html = page.html.clone();
    let framework = page.framework.clone();
    state
        .sessions
        .with_session(Some(session_id.to_string()), move |s| {
            s.current_page = Some(CurrentPage {
                url,
                title,
                text,
                html,
                framework,
            });
            if let Some(f) = page.framework.clone() {
                s.last_framework_hint = Some(f);
            }
            s.touch();
            Ok(())
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigate_result_from_page() {
        let page = PageResult {
            url: "https://example.com/".into(),
            title: "T".into(),
            html: "<html><head><title>T</title></head><body>hi</body></html>".into(),
            text: "hi".into(),
            links: vec![],
            framework: Some(FrameworkHint::Static),
            new_url: None,
        };
        let n = NavigateResult::from_page(page, Duration::from_millis(1));
        assert_eq!(n.url, "https://example.com/");
        assert!(n.html.contains("hi"));
    }
}
