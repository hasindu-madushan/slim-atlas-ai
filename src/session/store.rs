use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use http::HeaderMap;
use rmcp::schemars::JsonSchema;
use serde::Serialize;

use crate::error::{BrowserError, Result};
use crate::session::cookie;
use crate::session::id;
use crate::tiers::tier1_http::FrameworkHint;

/// Parsed, retainable snapshot of a fetched page.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct CurrentPage {
    pub url: String,
    pub title: String,
    pub text: String,
    pub html: String,
    pub framework: Option<FrameworkHint>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub tier: u8,
    pub timestamp_ms: u64,
}

pub struct Session {
    pub id: String,
    pub cookies: cookie::SessionCookies,
    pub custom_headers: HeaderMap,
    pub history: Vec<HistoryEntry>,
    pub current_page: Option<CurrentPage>,
    pub current_tier: u8,
    pub last_framework_hint: Option<FrameworkHint>,
    pub created_at: std::time::Instant,
    pub last_active: std::time::Instant,
}

impl Session {
    pub fn new(id: String, cookies: cookie::SessionCookies) -> Self {
        let now = std::time::Instant::now();
        Self {
            id,
            cookies,
            custom_headers: HeaderMap::new(),
            history: Vec::new(),
            current_page: None,
            current_tier: 0,
            last_framework_hint: None,
            created_at: now,
            last_active: now,
        }
    }

    pub fn touch(&mut self) {
        self.last_active = std::time::Instant::now();
    }

    pub fn soft_reset(&mut self) {
        // Replace the cookie jar with a fresh empty one. Callers that hold
        // the old `Arc<Jar>` (i.e. the `reqwest::Client` in `Tier1Http`) need
        // to be rebuilt to see the new jar. The MCP layer handles this in
        // `tools::reset` by calling `tier1.rebuild_for_session(...)`.
        let _old = self.cookies.replace_with_empty();
        self.custom_headers.clear();
        self.history.clear();
        self.current_page = None;
        self.current_tier = 0;
        self.last_framework_hint = None;
        self.touch();
    }
}

pub struct SessionStore {
    sessions: Arc<DashMap<String, Session>>,
    ttl: Duration,
    max_sessions: usize,
}

impl SessionStore {
    pub fn new(ttl: Duration, max_sessions: usize) -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            ttl,
            max_sessions,
        }
    }

    /// Create a new session with a fresh cookie jar and a random 4-char
    /// session ID (Crockford base32). The creation loop is bounded: with
    /// `max_sessions = 50` the collision probability is ~0.005% per call,
    /// and the 50% birthday-paradox threshold is ~1024 items, so the loop
    /// is effectively bounded for realistic `max_sessions` values.
    pub fn create(&self) -> String {
        // Evict oldest if we'd exceed the cap.
        if self.sessions.len() >= self.max_sessions {
            if let Some(oldest) = self
                .sessions
                .iter()
                .min_by_key(|e| e.value().last_active)
                .map(|e| e.key().clone())
            {
                self.sessions.remove(&oldest);
            }
        }
        // Retry on collision. The loop is a defensive no-op for any realistic
        // `max_sessions`; if it ever iterates, that's a sign we need to widen
        // the ID space.
        loop {
            let candidate = id::generate();
            if !self.sessions.contains_key(&candidate) {
                let session = Session::new(candidate.clone(), cookie::SessionCookies::new());
                self.sessions.insert(candidate.clone(), session);
                return candidate;
            }
        }
    }

    /// Returns `Ok(())` if the session exists, else `SessionNotFound`.
    pub fn assert_exists(&self, id: &str) -> Result<()> {
        if self.sessions.contains_key(id) {
            Ok(())
        } else {
            Err(BrowserError::SessionNotFound { id: id.to_string() })
        }
    }

    /// Apply `f` to the session, creating it first if `id` is `None`.
    pub fn with_session<F, R>(&self, id: Option<String>, f: F) -> Result<R>
    where
        F: FnOnce(&mut Session) -> Result<R>,
    {
        let id = match id {
            Some(id) => {
                self.assert_exists(&id)?;
                id
            }
            None => self.create(),
        };
        let mut entry = self
            .sessions
            .get_mut(&id)
            .expect("session just asserted to exist");
        let r = f(entry.value_mut());
        r
    }

    /// Drop all sessions whose `last_active` is older than `ttl`.
    pub fn cleanup_expired(&self) {
        let now = std::time::Instant::now();
        self.sessions
            .retain(|_, s| now.duration_since(s.last_active) < self.ttl);
    }

    /// Spawn a background task that runs `cleanup_expired` every `ttl / 2`.
    pub fn spawn_cleanup_task(self: Arc<Self>) {
        let interval = self.ttl / 2;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(interval);
            tick.tick().await; // skip the immediate fire
            loop {
                tick.tick().await;
                self.cleanup_expired();
            }
        });
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    fn small_ttl() -> Duration {
        Duration::from_millis(50)
    }

    #[test]
    fn create_and_assert() {
        let store = SessionStore::new(Duration::from_secs(60), 10);
        let id = store.create();
        assert!(store.assert_exists(&id).is_ok());
        let bogus = id::generate();
        assert!(matches!(
            store.assert_exists(&bogus),
            Err(BrowserError::SessionNotFound { .. })
        ));
    }

    #[test]
    fn with_session_auto_creates() {
        let store = SessionStore::new(Duration::from_secs(60), 10);
        let len_before = store.len();
        let result = store.with_session(None, |s| {
            s.history.push(HistoryEntry {
                url: "x".into(),
                title: "t".into(),
                tier: 1,
                timestamp_ms: 0,
            });
            Ok(s.history.len())
        });
        assert_eq!(result.unwrap(), 1);
        assert_eq!(store.len(), len_before + 1);
    }

    #[test]
    fn ttl_eviction() {
        let store = SessionStore::new(small_ttl(), 10);
        let id = store.create();
        assert!(store.assert_exists(&id).is_ok());
        sleep(small_ttl() * 2);
        store.cleanup_expired();
        assert!(store.assert_exists(&id).is_err());
    }

    #[test]
    fn max_sessions_evicts_oldest() {
        let store = SessionStore::new(Duration::from_secs(60), 2);
        let a = store.create();
        sleep(Duration::from_millis(5));
        let b = store.create();
        sleep(Duration::from_millis(5));
        // Touch `a` so `b` is the oldest.
        store
            .with_session(Some(a.clone()), |s| {
                s.touch();
                Ok(())
            })
            .unwrap();
        let _c = store.create();
        // `b` should be evicted; `a` and `c` remain.
        assert!(store.assert_exists(&a).is_ok());
        assert!(store.assert_exists(&b).is_err());
    }

    #[test]
    fn soft_reset_clears_state() {
        let store = SessionStore::new(Duration::from_secs(60), 10);
        let id = store.create();
        store
            .with_session(Some(id.clone()), |s| {
                s.history.push(HistoryEntry {
                    url: "x".into(),
                    title: "t".into(),
                    tier: 1,
                    timestamp_ms: 0,
                });
                s.current_page = Some(CurrentPage {
                    url: "x".into(),
                    title: "t".into(),
                    text: "y".into(),
                    html: "<p>y</p>".into(),
                    framework: None,
                });
                Ok(())
            })
            .unwrap();
        store
            .with_session(Some(id.clone()), |s| {
                s.soft_reset();
                assert!(s.history.is_empty());
                assert!(s.current_page.is_none());
                Ok(())
            })
            .unwrap();
    }
}
