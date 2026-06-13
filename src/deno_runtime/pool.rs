//! Concurrency-bounded dispatcher for [`DenoWorker`].
//!
//! Each call to [`DenoPool::execute`] acquires a permit from an internal
//! semaphore (size = `max_concurrency`), resolves the deno binary path
//! from the wrapped `DenoRuntime`, spawns a fresh deno subprocess,
//! and returns the parsed result.
//!
//! The pool is `Clone` and is meant to be wrapped in `Arc` and shared
//! from `AppState`. It's stateless across calls — every call is
//! independent — so `Clone` is just a `#[derive]`.
//!
//! ## Future: warm-pool
//!
//! The pool is shaped to be a drop-in upgrade site. When we add a warm
//! worker queue, the upgrade is: replace the `execute` body with
//! "checkout a worker or spawn a new one" and add an idle-reaper
//! background task. The public signature stays the same.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;

use crate::deno_runtime::protocol::{DenoRequest, DenoResult};
use crate::deno_runtime::worker::DenoWorker;
use crate::deno_runtime::DenoRuntime;
use crate::error::{BrowserError, Result};

#[derive(Debug, Clone)]
pub struct DenoPool {
    runtime: Arc<DenoRuntime>,
    script: PathBuf,
    semaphore: Arc<Semaphore>,
    /// Total permits ever acquired (lifetime). Surfaced as a stat for
    /// the in-flight T2 tests; not used for any logic.
    stats: Arc<PoolStats>,
}

#[derive(Debug, Default)]
struct PoolStats {
    /// Subprocess invocations completed (success or error).
    #[allow(dead_code)]
    calls: std::sync::atomic::AtomicU64,
    #[allow(dead_code)]
    timeouts: std::sync::atomic::AtomicU64,
}

impl DenoPool {
    /// Build a new pool bound to a `DenoRuntime`. The actual deno
    /// binary path is resolved lazily on each call to
    /// [`execute`](Self::execute), so construction stays cheap and
    /// doesn't trigger the install / PATH-lookup chain.
    pub fn new(runtime: Arc<DenoRuntime>, script: PathBuf, max_concurrency: usize) -> Self {
        let max_concurrency = max_concurrency.max(1);
        Self {
            runtime,
            script,
            semaphore: Arc::new(Semaphore::new(max_concurrency)),
            stats: Arc::new(PoolStats::default()),
        }
    }

    /// Maximum concurrent in-flight deno subprocesses.
    pub fn max_concurrency(&self) -> usize {
        self.semaphore.available_permits()
    }

    /// Run a single deno call. Blocks on the semaphore if the pool is
    /// saturated, resolves the deno binary path (installing on first
    /// call if needed), spawns one subprocess, and returns the result.
    pub async fn execute(
        &self,
        req: DenoRequest,
        allowed_hosts: Vec<String>,
        timeout: Duration,
    ) -> Result<DenoResult> {
        let _permit = self
            .semaphore
            .acquire()
            .await
            .expect("semaphore is never closed");
        let result = match self.runtime.resolve().await {
            Ok(resolved) => {
                let worker = DenoWorker::new(resolved.path.clone(), self.script.clone());
                worker.execute(&req, &allowed_hosts, timeout).await
            }
            Err(e) => Err(e),
        };
        self.stats
            .calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if matches!(&result, Err(BrowserError::Timeout { .. })) {
            self.stats
                .timeouts
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_clamps_concurrency_to_at_least_one() {
        let cfg = std::sync::Arc::new(crate::config::DenoConfig {
            deno_path: "/usr/bin/deno".into(),
            deno_version: "2.8.2".into(),
            script_path: "./render.ts".into(),
            pool_size: 0,
            idle_timeout_secs: 30,
            render_timeout_ms: 1000,
        });
        let rt = std::sync::Arc::new(DenoRuntime::new(cfg));
        let p = DenoPool::new(rt, PathBuf::from("./render.ts"), 0);
        assert_eq!(p.max_concurrency(), 1);
    }

    #[test]
    fn pool_preserves_concurrency_above_one() {
        let cfg = std::sync::Arc::new(crate::config::DenoConfig {
            deno_path: "/usr/bin/deno".into(),
            deno_version: "2.8.2".into(),
            script_path: "./render.ts".into(),
            pool_size: 4,
            idle_timeout_secs: 30,
            render_timeout_ms: 1000,
        });
        let rt = std::sync::Arc::new(DenoRuntime::new(cfg));
        let p = DenoPool::new(rt, PathBuf::from("./render.ts"), 4);
        assert_eq!(p.max_concurrency(), 4);
    }

    #[tokio::test]
    async fn pool_propagates_worker_errors() {
        let cfg = std::sync::Arc::new(crate::config::DenoConfig {
            deno_path: "/this/path/does/not/exist/deno".into(),
            deno_version: "2.8.2".into(),
            script_path: "./render.ts".into(),
            pool_size: 1,
            idle_timeout_secs: 30,
            render_timeout_ms: 1000,
        });
        let rt = std::sync::Arc::new(DenoRuntime::new(cfg));
        let p = DenoPool::new(rt, PathBuf::from("./render.ts"), 1);
        let req = DenoRequest::new_render("https://example.com/".into(), 1000);
        let err = p
            .execute(req, vec!["example.com".into()], Duration::from_secs(2))
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                BrowserError::DenoNotFound { .. } | BrowserError::DenoInstallFailed { .. }
            ),
            "got {err:?}"
        );
    }
}
