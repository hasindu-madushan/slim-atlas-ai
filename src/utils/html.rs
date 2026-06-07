use crate::error::BrowserError;
use rmcp::schemars::JsonSchema;
use scraper::{ElementRef, Html, Selector};

/// Walk the DOM, drop `script` / `style` / `noscript` / comments, join text nodes
/// with newlines, and collapse runs of whitespace into a single space.
///
/// Nav/footer/header text is preserved — LLM agents benefit from login links and
/// copyright. This may be re-evaluated in Phase 2 if the output is too noisy.
pub fn extract_text(html: &Html) -> String {
    let mut out = String::new();
    for node in html.tree.nodes() {
        let scraper::node::Node::Text(text) = node.value() else {
            continue;
        };
        let parent = node.parent();
        let Some(parent) = parent else { continue };
        let scraper::node::Node::Element(el) = parent.value() else {
            continue;
        };
        match el.name() {
            "script" | "style" | "noscript" | "template" => continue,
            _ => {}
        }
        let raw = &text.text;
        if raw.is_empty() {
            continue;
        }
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&collapse_whitespace(raw));
    }
    out
}

fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = false;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out
}

#[derive(Debug, Clone, serde::Serialize, JsonSchema)]
pub struct Link {
    pub text: String,
    pub href: String,
    pub absolute: String,
}

pub fn extract_links(html: &Html, base: &url::Url) -> Vec<Link> {
    let Ok(sel) = Selector::parse("a[href]") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for el in html.select(&sel) {
        let Some(href) = el.value().attr("href") else {
            continue;
        };
        let trimmed = href.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Filter non-navigable schemes outright. `mailto:` and `tel:` carry
        // useful data (and the text describes the destination), so we keep
        // them; `javascript:` is almost always a button, not a link.
        if trimmed
            .strip_prefix("javascript:")
            .or_else(|| trimmed.strip_prefix("data:"))
            .or_else(|| trimmed.strip_prefix("vbscript:"))
            .is_some()
        {
            continue;
        }
        if let Some(stripped) = trimmed
            .strip_prefix("mailto:")
            .or_else(|| trimmed.strip_prefix("tel:"))
        {
            if stripped.is_empty() {
                continue;
            }
        }
        // Pure fragment links: #foo — only keep if the page has a base URL we
        // can resolve against, otherwise they're not useful for navigation.
        let absolute = match base.join(trimmed) {
            Ok(u) => u.to_string(),
            Err(_) => continue,
        };
        let text = el.text().collect::<Vec<_>>().join(" ");
        let text = collapse_whitespace(text.trim());
        if text.is_empty() && !trimmed.starts_with('#') {
            continue;
        }
        out.push(Link {
            text,
            href: trimmed.to_string(),
            absolute,
        });
    }
    out
}

pub fn first_match<'a>(html: &'a Html, selector: &str) -> Result<ElementRef<'a>, BrowserError> {
    let sel = Selector::parse(selector).map_err(|_| BrowserError::SelectorNotFound {
        selector: selector.to_string(),
    })?;
    html.select(&sel)
        .next()
        .ok_or_else(|| BrowserError::SelectorNotFound {
            selector: selector.to_string(),
        })
}

pub fn all_matches<'a>(
    html: &'a Html,
    selector: &str,
) -> Result<Vec<ElementRef<'a>>, BrowserError> {
    let sel = Selector::parse(selector).map_err(|_| BrowserError::SelectorNotFound {
        selector: selector.to_string(),
    })?;
    Ok(html.select(&sel).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Html {
        Html::parse_document(s)
    }

    #[test]
    fn strips_script_and_style() {
        let html = parse("<p>hi</p><script>alert(1)</script><style>p{}</style><p>bye</p>");
        let text = extract_text(&html);
        assert!(text.contains("hi"));
        assert!(text.contains("bye"));
        assert!(!text.contains("alert"));
        assert!(!text.contains("p{}"));
    }

    #[test]
    fn collapses_whitespace() {
        let html = parse("<p>a   b\n\nc</p>");
        let text = extract_text(&html);
        assert!(text.contains("a b c"), "got: {text:?}");
    }

    #[test]
    fn extracts_links_resolves_relative() {
        let html = parse(
            r##"<html><body>
                <a href="/about">About</a>
                <a href="https://example.com/x">X</a>
                <a href="mailto:hi@x">M</a>
                <a href="javascript:void(0)">JS</a>
                <a href="#section">Frag</a>
            </body></html>"##,
        );
        let base = url::Url::parse("https://example.com/").unwrap();
        let links = extract_links(&html, &base);
        assert_eq!(links.len(), 4, "got: {links:?}");
        assert_eq!(links[0].absolute, "https://example.com/about");
        assert_eq!(links[1].absolute, "https://example.com/x");
        // mailto: kept; absolute resolution still works
        assert!(links.iter().any(|l| l.href == "mailto:hi@x"));
        // javascript: filtered out
        assert!(!links.iter().any(|l| l.href.starts_with("javascript:")));
        // Fragment-only links are kept (with text); empty-text fragment links
        // are dropped because they're not useful for navigation
        let frag = links.iter().find(|l| l.href == "#section").unwrap();
        assert_eq!(frag.text, "Frag");
    }

    #[test]
    fn selector_helpers_return_browser_error_on_parse_failure() {
        let html = parse("<p>x</p>");
        let err = first_match(&html, "[[[bad").unwrap_err();
        assert!(matches!(err, BrowserError::SelectorNotFound { .. }));
    }
}
