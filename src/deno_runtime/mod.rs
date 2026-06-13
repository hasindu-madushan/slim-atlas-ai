//! Auto-install + per-user cache for the Deno binary.
//!
//! Slim-atlas never installs Deno globally. The install flow targets a
//! per-user cache directory (`~/.cache/slim-atlas/deno/v<VERSION>/deno` on
//! Linux/macOS, `%LOCALAPPDATA%\slim-atlas\deno\v<VERSION>\deno.exe` on
//! Windows) and refuses to touch `/usr/local/bin` or any other system path.
//!
//! ## Resolution priority (used by `DenoRuntime::resolve`)
//!
//! 1. Explicit `[deno].deno_path` (or `DENO_PATH` env var) — use as-is, no
//!    version check. The user is telling us exactly what to run.
//! 2. Per-user cache at the version we want. Cheap, no network.
//! 3. `deno` on `$PATH` — verified with `deno --version`. Accepted if the
//!    reported major.minor.patch is at least `MIN_DENO_VERSION`. Older
//!    versions are rejected and we fall through to install.
//! 4. Download the platform zip from the GitHub release, verify SHA-256
//!    against the embedded manifest, extract to the cache, chmod +x, write
//!    a marker file so future startups skip the download.

pub mod install;
pub mod pool;
pub mod protocol;
pub mod worker;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::OnceCell;

use crate::config::DenoConfig;
use crate::error::BrowserError;

/// Errors that can come out of the resolution chain. `Clone` so we can
/// stash one in the `OnceCell` and return a copy to every caller. The
/// mapping from this to `BrowserError` lives in [`DenoRuntime::resolve`].
#[derive(Debug, Clone)]
pub enum InstallError {
    /// The user-configured `deno_path` is set but doesn't point to an
    /// executable file. This is a config error — we don't fall through
    /// to auto-install because the user asked for *this* path on
    /// purpose.
    NotFound { path: String },
    /// Download, extraction, or verification failure during auto-install.
    /// The `reason` is a user-facing message that ends up in the MCP
    /// error text.
    InstallFailed { reason: String },
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallError::NotFound { path } => write!(f, "deno not found at path: {path}"),
            InstallError::InstallFailed { reason } => write!(f, "deno install failed: {reason}"),
        }
    }
}

impl From<InstallError> for BrowserError {
    fn from(e: InstallError) -> Self {
        match e {
            InstallError::NotFound { path } => BrowserError::DenoNotFound { path },
            InstallError::InstallFailed { reason } => BrowserError::DenoInstallFailed { reason },
        }
    }
}

/// Lowest Deno version we'll accept from `$PATH` discovery. Set to 1.40
/// because that's the release that introduced comma-separated host lists in
/// `--allow-net` (needed for the cross-origin form-action and subresource
/// host allowlist). Older deno binaries are rejected — the
/// auto-install path will fetch a current build.
pub const MIN_DENO_VERSION: &str = "1.40.0";

/// Application-name suffix used when building the per-user cache directory.
const APP_DIR_NAME: &str = "slim-atlas";
const DENO_DIR_NAME: &str = "deno";

/// File written into the cache directory after a successful install. Records
/// the version, source URL, and the timestamp of the install. Its presence
/// is what tells `resolve()` step 2 the cache is populated; the binary's
/// existence is necessary but not sufficient (a half-extracted install
/// should not be trusted).
pub const INSTALL_MARKER: &str = ".install-marker";

/// Resolved location of the `deno` binary plus the config that produced it.
#[derive(Debug, Clone)]
pub struct ResolvedDeno {
    /// Absolute path to the executable. Already verified to exist and be
    /// runnable at resolution time.
    pub path: PathBuf,
    /// Where this resolution came from. Surfaced in logs and the install
    /// marker for debugging.
    pub source: DenoSource,
    /// Reported major.minor.patch from `deno --version`, when available.
    /// `None` for explicit-path resolutions (we don't shell out to verify
    /// user-supplied binaries in v1).
    pub version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenoSource {
    /// User-supplied `deno_path` config or `DENO_PATH` env var.
    ExplicitPath,
    /// Per-user cache (`~/.cache/slim-atlas/deno/v<VERSION>/deno`).
    Cache,
    /// `$PATH` discovery; the binary was already installed system-wide.
    PathLookup,
    /// We just downloaded and extracted it into the cache.
    AutoInstalled,
}

impl DenoSource {
    pub fn as_str(self) -> &'static str {
        match self {
            DenoSource::ExplicitPath => "explicit-path",
            DenoSource::Cache => "cache",
            DenoSource::PathLookup => "path-lookup",
            DenoSource::AutoInstalled => "auto-installed",
        }
    }
}

/// Owns the `DenoConfig` and exposes a lazily-resolved `deno` binary path.
///
/// Construction is cheap (just clones the config into an `Arc`). The actual
/// discovery + possible install happens on the first call to
/// [`resolve`](Self::resolve), and the result is cached for the process's
/// lifetime — repeated T2 calls reuse the same path.
#[derive(Debug)]
pub struct DenoRuntime {
    config: Arc<DenoConfig>,
    resolved: OnceCell<std::result::Result<ResolvedDeno, InstallError>>,
}

impl DenoRuntime {
    pub fn new(config: Arc<DenoConfig>) -> Self {
        Self {
            config,
            resolved: OnceCell::new(),
        }
    }

    /// Return the config this runtime was built from.
    pub fn config(&self) -> &DenoConfig {
        &self.config
    }

    /// Resolve the `deno` binary path, performing the four-step discovery
    /// described in the module docs. The first call does the work; subsequent
    /// calls return the cached `Result` (success or failure). Errors from
    /// this layer are mapped into the project-wide [`BrowserError`] shape
    /// so MCP handlers don't need to know about [`InstallError`].
    pub async fn resolve(&self) -> std::result::Result<&ResolvedDeno, BrowserError> {
        let result = self
            .resolved
            .get_or_init(|| install::resolve(&self.config))
            .await;
        result.as_ref().map_err(|e| e.clone().into())
    }

    /// Returns true if resolution has already succeeded in this process.
    /// Used by tests and the idle-reaper to avoid racing an install.
    pub fn is_resolved(&self) -> bool {
        self.resolved.get().is_some_and(|r| r.is_ok())
    }

    /// The absolute path of the per-user cache directory for the configured
    /// Deno version. Created on demand by `install::download_and_extract`.
    /// Exposed for tests + the `reset` tool's "wipe Deno cache" path.
    pub fn cache_dir(&self) -> std::result::Result<PathBuf, BrowserError> {
        install::cache_dir_for(&self.config.deno_version).map_err(Into::into)
    }

    /// The absolute path of the cached binary (not yet known to exist).
    pub fn cache_binary_path(&self) -> std::result::Result<PathBuf, BrowserError> {
        Ok(self.cache_dir()?.join(install::binary_filename()))
    }
}

/// Returns the configured `deno_path` if non-empty, else `None`. Used by
/// `install::resolve` and exposed for tests.
pub(crate) fn explicit_path(config: &DenoConfig) -> Option<PathBuf> {
    let p = config.deno_path.trim();
    if p.is_empty() {
        None
    } else {
        Some(PathBuf::from(p))
    }
}

/// Predicate: is `path` a file we can attempt to execute? Used by the
/// resolution steps to skip missing/unreadable candidates without
/// surfacing an error.
pub(crate) fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    // On Unix, check the executable bit. On Windows, the file extension
    // (handled by the OS at exec time) is the gate; we just need to know
    // the file exists.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_path_none_when_empty() {
        let cfg = DenoConfig {
            deno_path: String::new(),
            ..make_test_config()
        };
        assert!(explicit_path(&cfg).is_none());
    }

    #[test]
    fn explicit_path_none_when_whitespace() {
        let cfg = DenoConfig {
            deno_path: "   ".into(),
            ..make_test_config()
        };
        assert!(explicit_path(&cfg).is_none());
    }

    #[test]
    fn explicit_path_some_when_set() {
        let cfg = DenoConfig {
            deno_path: "/usr/bin/deno".into(),
            ..make_test_config()
        };
        assert_eq!(explicit_path(&cfg).unwrap(), PathBuf::from("/usr/bin/deno"));
    }

    #[test]
    fn is_executable_file_rejects_nonexistent() {
        assert!(!is_executable_file(Path::new(
            "/this/path/should/never/exist/deno"
        )));
    }

    #[test]
    fn is_executable_file_rejects_directory() {
        // The Cargo target dir definitely exists and is a directory.
        let target = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()));
        if let Some(dir) = target {
            assert!(!is_executable_file(&dir));
        }
    }

    #[test]
    fn min_deno_version_is_parsable() {
        let parts: Vec<&str> = MIN_DENO_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3, "MIN_DENO_VERSION must be major.minor.patch");
        for p in parts {
            p.parse::<u32>()
                .expect("MIN_DENO_VERSION components must be numeric");
        }
    }

    fn make_test_config() -> DenoConfig {
        DenoConfig {
            deno_path: String::new(),
            deno_version: "2.8.2".into(),
            script_path: "./deno/render.ts".into(),
            pool_size: 2,
            idle_timeout_secs: 30,
            render_timeout_ms: 10_000,
        }
    }
}
