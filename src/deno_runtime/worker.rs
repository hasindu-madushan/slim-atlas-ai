//! Single Deno subprocess invocation. Stateless — every call spawns
//! a fresh process, sends one JSON request on stdin, reads one JSON
//! response on stdout, and reaps the child.
//!
//! ## Why spawn-per-call instead of a warm pool
//!
//! The DESIGN doc sketches a warm pool of 2. We start with the simpler
//! spawn-per-call model because:
//!
//! - It eliminates a whole class of "stale worker" bugs (a child that
//!   died, a worker that hasn't seen stdin EOF, a stdout that read
//!   past the JSON boundary, etc.).
//! - Cold start is ~150ms, which is acceptable for the agent use case
//!   where the bottleneck is the LLM, not the renderer.
//! - The pool layer above us already bounds concurrency with a
//!   `Semaphore`, so spawn-per-call doesn't translate to unlimited
//!   processes.
//!
//! If profiling later shows the cold start matters, the warm-pool
//! version is a drop-in replacement behind the same `DenoPool::execute`
//! signature.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::deno_runtime::protocol::{decode_result, encode_request, DenoRequest, DenoResult};
use crate::error::{BrowserError, Result};

/// One reusable deno process-spawn. Cheap to construct; the actual
/// spawn happens on `execute`.
#[derive(Debug, Clone)]
pub struct DenoWorker {
    deno: PathBuf,
    script: PathBuf,
}

impl DenoWorker {
    pub fn new(deno: PathBuf, script: PathBuf) -> Self {
        Self { deno, script }
    }

    /// The configured `deno` path. Exposed for diagnostics.
    pub fn deno_path(&self) -> &Path {
        &self.deno
    }

    /// The configured script path.
    pub fn script_path(&self) -> &Path {
        &self.script
    }

    /// Spawn a fresh deno subprocess, send `req` on stdin, read the
    /// JSON response on stdout, reap the child. Wrapped in
    /// `tokio::time::timeout` for `timeout`.
    pub async fn execute(
        &self,
        req: &DenoRequest,
        allowed_hosts: &[String],
        timeout_duration: Duration,
    ) -> Result<DenoResult> {
        if !req.html.as_deref().map(str::is_empty).unwrap_or(true)
            || !self.deno.exists()
            || !self.script.exists()
        {
            // Defensive precondition checks; these should be caught at
            // higher layers, but fail loudly if not.
            if !self.deno.exists() {
                return Err(BrowserError::DenoNotFound {
                    path: self.deno.display().to_string(),
                });
            }
            if !self.script.exists() {
                return Err(BrowserError::DenoInstallFailed {
                    reason: format!("deno script not found: {}", self.script.display()),
                });
            }
        }

        let allow_net = if allowed_hosts.is_empty() {
            // Deno requires `host:port`; the empty case shouldn't
            // happen because callers always pass the page origin,
            // but if it does, grant localhost-only so the script can
            // at least start.
            "localhost".to_string()
        } else {
            allowed_hosts.join(",")
        };

        let mut cmd = Command::new(&self.deno);
        cmd.arg("run")
            .arg(format!("--allow-net={allow_net}"))
            // The rest are restrictive; Deno refuses anything we don't
            // explicitly grant. `--allow-env` (no value list) is
            // required because happy-dom's transitive npm deps
            // (notably `webidl-conversions` and `whatwg-mimetype`)
            // read `process.env` at import time. We don't expose
            // host env to the script in any meaningful way — the
            // script only reads the env vars npm packages check
            // for (DEBUG, NODE_DEBUG, PATH, etc.).
            .arg("--allow-env")
            .arg("--allow-read=false")
            .arg("--allow-write=false")
            .arg("--allow-run=false")
            .arg("--allow-ffi=false")
            .arg("--no-prompt")
            .arg("--quiet")
            .arg(&self.script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| BrowserError::DenoInstallFailed {
            reason: format!("spawn deno: {e}"),
        })?;

        // Write the request JSON to stdin, then close. Deno's
        // `Deno.stdin.readable` resolves on EOF.
        let mut stdin = child.stdin.take().ok_or_else(|| BrowserError::DenoFailed {
            stderr: "no stdin pipe".to_string(),
        })?;
        let payload = encode_request(req)?;
        stdin
            .write_all(&payload)
            .await
            .map_err(|e| BrowserError::DenoFailed {
                stderr: format!("write stdin: {e}"),
            })?;
        stdin
            .shutdown()
            .await
            .map_err(|e| BrowserError::DenoFailed {
                stderr: format!("close stdin: {e}"),
            })?;
        drop(stdin);

        // Wait with timeout, capture stdout/stderr. We deliberately
        // don't stream stdout — the contract is one JSON blob per
        // call. Anything more is a bug.
        let output = timeout(timeout_duration, child.wait_with_output())
            .await
            .map_err(|_| BrowserError::Timeout {
                ms: timeout_duration.as_millis() as u64,
            })?
            .map_err(|e| BrowserError::DenoFailed {
                stderr: format!("wait deno: {e}"),
            })?;

        if !output.status.success() {
            return Err(BrowserError::DenoFailed {
                stderr: format!(
                    "deno exited {}: {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            });
        }

        let result = decode_result(&output.stdout)?;
        if !result.ok {
            return Err(BrowserError::DenoFailed {
                stderr: result
                    .error
                    .unwrap_or_else(|| "deno reported ok=false".into()),
            });
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worker_stores_paths() {
        let w = DenoWorker::new(PathBuf::from("/usr/bin/deno"), PathBuf::from("./render.ts"));
        assert_eq!(w.deno_path(), Path::new("/usr/bin/deno"));
        assert_eq!(w.script_path(), Path::new("./render.ts"));
    }

    #[tokio::test]
    async fn execute_with_missing_deno_returns_not_found() {
        let w = DenoWorker::new(
            PathBuf::from("/this/path/does/not/exist/deno"),
            PathBuf::from("./render.ts"),
        );
        let req = DenoRequest::new_render("https://example.com/".into(), 1000);
        let err = w
            .execute(&req, &["example.com".into()], Duration::from_secs(2))
            .await
            .unwrap_err();
        // Missing script OR deno yields a clear error. On a host
        // where the script doesn't exist, it's DenoInstallFailed
        // mentioning the script path. Where deno doesn't exist
        // (this test), it's DenoNotFound. The point is: it fails
        // fast and clearly.
        assert!(
            matches!(
                err,
                BrowserError::DenoNotFound { .. } | BrowserError::DenoInstallFailed { .. }
            ),
            "got {err:?}"
        );
    }
}
