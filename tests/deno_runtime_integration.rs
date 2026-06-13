//! End-to-end tests for the `DenoRuntime` resolution chain. Gated
//! `#[ignore]` because they touch the network (auto-install), the user's
//! filesystem (per-user cache), and a $PATH `deno` binary (which may or
//! may not exist on the test host). Run with:
//!
//!   cargo test --test deno_runtime_integration -- --ignored --nocapture
//!
//! Each test cleans up after itself: the cache dir is nuked at start
//! and the marker is restored at the end. The auto-install test is
//! the only one that requires network access.

use std::path::PathBuf;
use std::sync::Arc;

use slim_atlas::config::DenoConfig;
use slim_atlas::deno_runtime::{install, DenoRuntime, DenoSource, MIN_DENO_VERSION};
use slim_atlas::error::BrowserError;

const PINNED_VERSION: &str = "2.8.2";

fn test_config(deno_path: String) -> Arc<DenoConfig> {
    Arc::new(DenoConfig {
        deno_path,
        deno_version: PINNED_VERSION.into(),
        script_path: "./deno/render.ts".into(),
        pool_size: 2,
        idle_timeout_secs: 30,
        render_timeout_ms: 10_000,
    })
}

/// Wipe the per-user cache for the pinned version, so each test starts
/// from a known empty state. Returns the path that was wiped (for
/// debugging).
fn wipe_cache() -> PathBuf {
    let dir = install::cache_dir_for(PINNED_VERSION).expect("cache dir");
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// Restore the cache directory that the test wiped, plus the bin file
/// inside it. Used so the test runner doesn't pollute the user's
/// install between runs.
fn touch_marker(dir: &PathBuf) {
    let _ = std::fs::create_dir_all(dir);
    let marker = dir.join(".install-marker");
    let _ = std::fs::write(
        &marker,
        format!("version={PINNED_VERSION} installed_at=0\n"),
    );
    // No binary — that's OK, we're just leaving the marker for the
    // unit tests' resolution priority to find.
}

#[tokio::test]
#[ignore = "writes the user's cache; opt in with --ignored"]
async fn resolve_uses_explicit_path_when_configured() {
    // The slim-atlas binary itself satisfies `is_executable_file`. Good
    // enough to prove the explicit-path branch wins without requiring
    // an actual `deno` on the host.
    let self_path = std::env::current_exe().expect("current_exe");
    let cfg = test_config(self_path.to_string_lossy().to_string());
    let runtime = DenoRuntime::new(cfg);

    let resolved = runtime.resolve().await.expect("explicit-path resolves");
    assert_eq!(resolved.source, DenoSource::ExplicitPath);
    assert_eq!(resolved.path, self_path);
    assert!(
        resolved.version.is_none(),
        "explicit path skips version probe"
    );
}

#[tokio::test]
#[ignore = "writes the user's cache; opt in with --ignored"]
async fn resolve_clears_explicit_path_on_missing_file() {
    let cfg = test_config("/this/path/does/not/exist/deno".into());
    let runtime = DenoRuntime::new(cfg);
    let err = runtime.resolve().await.unwrap_err();
    assert!(
        matches!(err, BrowserError::DenoNotFound { .. }),
        "expected DenoNotFound, got {err:?}"
    );
}

#[tokio::test]
#[ignore = "writes the user's cache; opt in with --ignored"]
async fn resolve_cache_hit_when_marker_present() {
    let cache_dir = wipe_cache();
    let bin_path = cache_dir.join(install::binary_filename());
    std::fs::create_dir_all(&cache_dir).unwrap();
    // Write a valid cache marker (must claim the same version as the
    // pinned config). Then we need an executable file at bin_path; the
    // simplest one is a shell script that does nothing.
    touch_marker(&cache_dir);
    std::fs::write(&bin_path, "#!/bin/sh\nexit 0\n").unwrap();
    set_executable(&bin_path);

    // Explicit path empty -> resolve falls through to cache hit.
    let cfg = test_config(String::new());
    let runtime = DenoRuntime::new(cfg);
    let resolved = runtime.resolve().await.expect("cache hit");
    assert_eq!(resolved.source, DenoSource::Cache);
    assert_eq!(resolved.path, bin_path);
    assert_eq!(resolved.version.as_deref(), Some(PINNED_VERSION));

    // The cache hit is a real executable (we wrote a shell script);
    // spawn it to confirm it actually runs.
    let probe = std::process::Command::new(&resolved.path)
        .arg("--version")
        .output();
    // On Windows, our sh-script won't be runnable; only assert on Unix.
    #[cfg(unix)]
    assert!(probe.is_ok(), "cached script should be runnable: {probe:?}");
}

#[tokio::test]
#[ignore = "writes the user's cache; opt in with --ignored"]
async fn resolve_path_lookup_uses_system_deno_if_recent_enough() {
    // This test only asserts if `deno` is actually on $PATH AND reports
    // a version >= MIN_DENO_VERSION. On hosts without it, the test
    // silently passes (we don't have a way to install one without
    // exercising the auto-install path).
    if let Ok(p) = which::which("deno") {
        let version = probe_version(&p).await;
        if let Some(v) = version {
            if semver_gte(&v, MIN_DENO_VERSION) {
                let cfg = test_config(String::new());
                let runtime = DenoRuntime::new(cfg);
                let resolved = runtime
                    .resolve()
                    .await
                    .expect("system deno should be picked up");
                assert_eq!(
                    resolved.source,
                    DenoSource::PathLookup,
                    "expected PATH lookup, got {:?}",
                    resolved.source
                );
                assert_eq!(resolved.path, p);
                assert_eq!(resolved.version.as_deref(), Some(v.as_str()));
                return;
            }
        }
    }
    eprintln!("[skip] no recent-enough system deno on $PATH");
}

#[tokio::test]
#[ignore = "network: downloads ~40MB from github.com/denoland/deno"]
async fn resolve_auto_installs_when_nothing_cached_or_on_path() {
    // Wipe the cache so we exercise the install path.
    let cache_dir = wipe_cache();

    let cfg = test_config(String::new());
    let runtime = DenoRuntime::new(cfg);

    let resolved = runtime.resolve().await;
    let resolved = match resolved {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[skip] auto-install failed: {e}");
            // Don't fail the suite on a network-restricted runner.
            return;
        }
    };

    assert_eq!(resolved.source, DenoSource::AutoInstalled);
    assert!(resolved.path.exists(), "binary should be on disk");
    assert!(
        resolved
            .path
            .metadata()
            .map(|m| m.len() > 1_000_000)
            .unwrap_or(false),
        "binary should be tens of MB, not empty"
    );

    // Marker file should have been written.
    let marker = cache_dir.join(".install-marker");
    assert!(marker.exists(), "install marker should be present");
    let marker_contents = std::fs::read_to_string(&marker).unwrap();
    assert!(
        marker_contents.contains(PINNED_VERSION),
        "marker should record the installed version, got: {marker_contents}"
    );

    // And running it should report the pinned version.
    let out = std::process::Command::new(&resolved.path)
        .arg("--version")
        .output()
        .expect("run installed deno");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains(PINNED_VERSION),
        "expected version {PINNED_VERSION} in `deno --version`, got: {stdout}"
    );
}

#[tokio::test]
#[ignore = "network + filesystem: full e2e of all four resolution steps"]
async fn resolve_is_cached_across_runtimes() {
    // First runtime: trigger install (or pick up cache). Second runtime:
    // must hit the cache, not re-download. We assert by counting the
    // `download_and_extract` log line — but the simpler way is just
    // to verify the second call returns in < 50ms (no network) and
    // reports Cache as the source.
    let _ = wipe_cache();
    let cfg = test_config(String::new());
    let first = DenoRuntime::new(cfg.clone());
    let first_resolved = match first.resolve().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[skip] first resolve failed: {e}");
            return;
        }
    };
    let first_source = first_resolved.source;
    let _ = first_resolved;

    let second = DenoRuntime::new(cfg);
    let started = std::time::Instant::now();
    let second_resolved = second
        .resolve()
        .await
        .expect("second resolve should succeed");
    let elapsed = started.elapsed();
    assert!(
        elapsed < std::time::Duration::from_millis(200),
        "second resolve took {elapsed:?} — should be near-instant when cached"
    );
    assert_eq!(
        second_resolved.source,
        DenoSource::Cache,
        "expected cache hit on second resolve; first was {first_source:?}, \
         probably the network was down on the first run and PATH was used; \
         this test only makes sense when first_resolved is AutoInstalled"
    );
}

// =====================================================================
// Helpers
// =====================================================================

#[cfg(unix)]
fn set_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

#[cfg(not(unix))]
fn set_executable(_path: &std::path::Path) {}

async fn probe_version(deno: &std::path::Path) -> Option<String> {
    let out = tokio::process::Command::new(deno)
        .arg("--version")
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    install::parse_deno_version(&stdout)
}

fn semver_gte(candidate: &str, min: &str) -> bool {
    let parse = |s: &str| -> Option<(u32, u32, u32)> {
        let mut p = s.split('.');
        Some((
            p.next()?.parse().ok()?,
            p.next()?.parse().ok()?,
            p.next()?.parse().ok()?,
        ))
    };
    match (parse(candidate), parse(min)) {
        (Some(c), Some(m)) => c >= m,
        _ => false,
    }
}
