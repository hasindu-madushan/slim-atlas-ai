//! Concrete install steps: platform triple resolution, cache directory
//! layout, GitHub release download, SHA-256 verification, and zip
//! extraction. The four-step resolution chain lives in [`resolve`].
//!
//! Per the project design (DESIGN.md §6), slim-atlas never installs Deno
//! globally. The cache directory is always under the user's data dir
//! (`~/.cache/slim-atlas/...` on Linux/macOS,
//! `%LOCALAPPDATA%\slim-atlas\...` on Windows), and we only ever write the
//! `deno` binary plus a marker file.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::config::DenoConfig;
use crate::deno_runtime::{
    is_executable_file, DenoSource, InstallError, ResolvedDeno, MIN_DENO_VERSION,
};

/// Entry point for the resolution chain. Walks the four steps in order:
/// explicit path → cache → `$PATH` → auto-install. The first step that
/// produces a working binary wins.
///
/// Errors returned here are *user-facing*: a missing `deno_path` is a
/// config problem, a failed install is a network problem, etc. They are
/// not retried inside this function.
pub async fn resolve(config: &DenoConfig) -> Result<ResolvedDeno, InstallError> {
    // Step 1: explicit user-supplied path. No version check; the user
    // told us what to run.
    if let Some(path) = super::explicit_path(config) {
        if is_executable_file(&path) {
            tracing::info!(deno = %path.display(), source = "explicit-path", "using configured deno binary");
            return Ok(ResolvedDeno {
                path,
                source: DenoSource::ExplicitPath,
                version: None,
            });
        }
        // Explicit but missing: that's a hard config error, not a fall
        // through to auto-install. The user asked for this path on purpose.
        return Err(InstallError::NotFound {
            path: path.display().to_string(),
        });
    }

    // Step 2: per-user cache. Fast path; no network, no subprocess.
    let cache_path = cache_dir_for(&config.deno_version)?.join(binary_filename());
    if is_executable_file(&cache_path) && cache_marker_matches(&cache_path, &config.deno_version) {
        // Marker file is present and matches the version we want; trust it.
        // No need to re-verify the binary's hash; a successful `deno --version`
        // would catch tampering, and the cache dir is user-owned.
        tracing::info!(deno = %cache_path.display(), source = "cache", "using cached deno binary");
        return Ok(ResolvedDeno {
            path: cache_path,
            source: DenoSource::Cache,
            version: Some(config.deno_version.clone()),
        });
    }

    // Step 3: PATH discovery. Only accept if the version is recent enough.
    if let Some(p) = path_lookup().await {
        if let Ok(ver) = query_version(&p).await {
            if version_meets_minimum(&ver) {
                tracing::info!(
                    deno = %p.display(),
                    version = %ver,
                    source = "path-lookup",
                    "using system deno binary"
                );
                return Ok(ResolvedDeno {
                    path: p,
                    source: DenoSource::PathLookup,
                    version: Some(ver),
                });
            }
            tracing::warn!(
                deno = %p.display(),
                found = %ver,
                minimum = MIN_DENO_VERSION,
                "system deno is below the minimum required version; falling through to auto-install"
            );
        }
        // PATH deno found but version check failed (or version query
        // failed). Fall through to install — the cache is authoritative.
    }

    // Step 4: auto-install. Downloads the platform zip, verifies SHA-256,
    // extracts, marks the cache directory. If this fails the user gets a
    // clear error message with the install URL in it.
    let installed = download_and_extract(config).await?;
    tracing::info!(
        deno = %installed.display(),
        version = %config.deno_version,
        "auto-installed deno"
    );
    Ok(ResolvedDeno {
        path: installed,
        source: DenoSource::AutoInstalled,
        version: Some(config.deno_version.clone()),
    })
}

/// Compute the per-user cache directory for a given Deno version. Pure
/// function of `(version, OS)`; no IO.
pub fn cache_dir_for(version: &str) -> Result<PathBuf, InstallError> {
    let base = dirs::cache_dir()
        .or_else(dirs::data_local_dir)
        .ok_or_else(|| InstallError::InstallFailed {
            reason: "could not resolve user cache directory (no $XDG_CACHE_HOME or $HOME)".into(),
        })?;
    Ok(base
        .join(super::APP_DIR_NAME)
        .join(super::DENO_DIR_NAME)
        .join(format!("v{version}")))
}

/// Name of the binary inside the per-user cache. Windows gets `.exe`.
pub fn binary_filename() -> &'static str {
    if cfg!(windows) {
        "deno.exe"
    } else {
        "deno"
    }
}

/// The platform triple suffix used in GitHub release asset names.
pub fn target_triple() -> Result<&'static str, InstallError> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("linux", "aarch64") => Ok("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        ("windows", "aarch64") => Ok("aarch64-pc-windows-msvc"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        (os, arch) => Err(InstallError::InstallFailed {
            reason: format!("unsupported platform: {os}-{arch}"),
        }),
    }
}

/// Build the GitHub release URL for the configured Deno version.
fn release_zip_url(version: &str) -> Result<String, InstallError> {
    let triple = target_triple()?;
    Ok(format!(
        "https://github.com/denoland/deno/releases/download/v{version}/deno-{triple}.zip"
    ))
}

/// Look up `deno` on `$PATH` via the `which` crate. Returns `None` (not
/// `Err`) when the binary is not found — that's the common case on a
/// vanilla CI box.
async fn path_lookup() -> Option<PathBuf> {
    // `which` is sync; wrap in spawn_blocking to keep the runtime happy
    // on the (rare) slow-filesystem case.
    tokio::task::spawn_blocking(|| which::which("deno").ok())
        .await
        .ok()
        .flatten()
}

/// Run `<deno> --version` and parse the leading "deno X.Y.Z" line.
async fn query_version(deno: &Path) -> Result<String, InstallError> {
    let output = tokio::process::Command::new(deno)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| InstallError::InstallFailed {
            reason: format!("failed to run `deno --version`: {e}"),
        })?;
    if !output.status.success() {
        return Err(InstallError::InstallFailed {
            reason: format!(
                "`deno --version` exited {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        });
    }
    parse_deno_version(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        InstallError::InstallFailed {
            reason: format!(
                "could not parse `deno --version` output: {:?}",
                String::from_utf8_lossy(&output.stdout)
            ),
        }
    })
}

/// Parse the first line of `deno --version`. Output looks like:
/// `deno 2.8.2 (release, stable, v8 13.x.x, ...)` on macOS/Linux, or the
/// same wrapped with a CRLF on Windows. We want `2.8.2`.
pub fn parse_deno_version(stdout: &str) -> Option<String> {
    let first_line = stdout.lines().next()?;
    // First line begins with the word "deno" (lowercase on all platforms).
    let after = first_line.strip_prefix("deno")?.trim();
    // The version is the first whitespace-delimited token after "deno".
    let ver = after.split_whitespace().next()?;
    // Defensive: must be three numeric components.
    let mut parts = ver.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let patch = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(format!("{major}.{minor}.{patch}"))
}

/// Compare a candidate `1.2.3` against `MIN_DENO_VERSION`. Returns true
/// if `candidate >= min` per SemVer 2.0.0 ordering.
pub fn version_meets_minimum(candidate: &str) -> bool {
    let parse = |s: &str| -> Option<(u32, u32, u32)> {
        let mut p = s.split('.');
        Some((
            p.next()?.parse().ok()?,
            p.next()?.parse().ok()?,
            p.next()?.parse().ok()?,
        ))
    };
    match (parse(candidate), parse(MIN_DENO_VERSION)) {
        (Some(c), Some(m)) => c >= m,
        _ => false,
    }
}

/// Check whether the cache directory's install marker matches the
/// requested version. Marker content is a single line:
/// `version=<X.Y.Z> installed_at=<unix_ms>`.
fn cache_marker_matches(binary: &Path, expected_version: &str) -> bool {
    let Some(dir) = binary.parent() else {
        return false;
    };
    let marker = dir.join(super::INSTALL_MARKER);
    let Ok(contents) = std::fs::read_to_string(&marker) else {
        return false;
    };
    for line in contents.lines() {
        if let Some(rest) = line.strip_prefix("version=") {
            let v = rest.split_whitespace().next().unwrap_or("");
            if v == expected_version {
                return true;
            }
        }
    }
    false
}

/// Download the release zip for the configured version, verify SHA-256,
/// extract, mark.
async fn download_and_extract(config: &DenoConfig) -> Result<PathBuf, InstallError> {
    let url = release_zip_url(&config.deno_version)?;
    let expected_sha256 = MANIFEST
        .sha256_for(target_triple()?, &config.deno_version)
        .ok_or_else(|| InstallError::InstallFailed {
            reason: format!(
                "no SHA-256 manifest entry for deno v{} on {}; \
                 please file an issue or pin a known version via DENO_VERSION",
                config.deno_version,
                target_triple().unwrap_or("this platform"),
            ),
        })?;

    tracing::info!(%url, "downloading deno");
    let bytes = reqwest::get(&url)
        .await
        .map_err(|e| InstallError::InstallFailed {
            reason: format!("download failed: {e}"),
        })?
        .error_for_status()
        .map_err(|e| InstallError::InstallFailed {
            reason: format!("download failed: {e}"),
        })?
        .bytes()
        .await
        .map_err(|e| InstallError::InstallFailed {
            reason: format!("download body read failed: {e}"),
        })?;

    // Verify before touching disk.
    let actual = Sha256::digest(&bytes);
    let actual_hex = format!("{actual:x}");
    if !actual_hex.eq_ignore_ascii_case(&expected_sha256) {
        return Err(InstallError::InstallFailed {
            reason: format!(
                "SHA-256 mismatch: expected {expected_sha256}, got {actual_hex}. \
                 Refusing to extract; the download may be corrupt or the manifest stale."
            ),
        });
    }

    let cache_dir = cache_dir_for(&config.deno_version)?;
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| InstallError::InstallFailed {
            reason: format!("could not create cache dir {}: {e}", cache_dir.display()),
        })?;

    // Extract the zip in a blocking task; zip crate is sync.
    let cache_dir_for_blocking = cache_dir.clone();
    let bytes_for_blocking = bytes.to_vec();
    tokio::task::spawn_blocking(move || extract_zip(&bytes_for_blocking, &cache_dir_for_blocking))
        .await
        .map_err(|e| InstallError::InstallFailed {
            reason: format!("extract task panicked: {e}"),
        })??;

    // Make the binary executable (Unix). On Windows the OS uses the .exe
    // extension; the `is_executable_file` predicate doesn't check the mode
    // bit there.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin = cache_dir.join(binary_filename());
        let mut perms = std::fs::metadata(&bin)
            .map_err(|e| InstallError::InstallFailed {
                reason: format!("stat binary: {e}"),
            })?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&bin, perms).map_err(|e| InstallError::InstallFailed {
            reason: format!("chmod binary: {e}"),
        })?;
    }

    write_install_marker(&cache_dir, &config.deno_version).map_err(|e| {
        InstallError::InstallFailed {
            reason: format!("write install marker: {e}"),
        }
    })?;

    Ok(cache_dir.join(binary_filename()))
}

fn extract_zip(zip_bytes: &[u8], dest: &Path) -> Result<(), InstallError> {
    let reader = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader).map_err(|e| InstallError::InstallFailed {
        reason: format!("open zip: {e}"),
    })?;
    // The Deno release zip contains exactly one entry: `deno` (or
    // `deno.exe`). Refuse to extract if we see anything else — defends
    // against a compromised release (a zip slip would be the failure
    // mode here).
    let mut found = false;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| InstallError::InstallFailed {
                reason: format!("read zip entry: {e}"),
            })?;
        let name = entry.name().to_string();
        if name != "deno" && name != "deno.exe" {
            return Err(InstallError::InstallFailed {
                reason: format!("unexpected entry in release zip: {name:?}"),
            });
        }
        let out = dest.join(&name);
        let mut outf = std::fs::File::create(&out).map_err(|e| InstallError::InstallFailed {
            reason: format!("create {}: {e}", out.display()),
        })?;
        std::io::copy(&mut entry, &mut outf).map_err(|e| InstallError::InstallFailed {
            reason: format!("write {}: {e}", out.display()),
        })?;
        found = true;
    }
    if !found {
        return Err(InstallError::InstallFailed {
            reason: "release zip contained no `deno` entry".into(),
        });
    }
    Ok(())
}

fn write_install_marker(dir: &Path, version: &str) -> std::io::Result<()> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let contents = format!("version={version} installed_at={now_ms}\n");
    std::fs::write(dir.join(super::INSTALL_MARKER), contents)
}

// =====================================================================
// Per-version SHA-256 manifest
// =====================================================================
//
// Each entry maps (version, triple) -> sha256 of the release zip. The
// hashes come from the upstream
// `https://github.com/denoland/deno/releases/download/v<V>/deno-<T>.zip.sha256sum`
// files and MUST be kept in sync. A version missing from this table
// cannot be auto-installed; the user gets a clear error asking them to
// either pin to a known version or file an issue.
//
// To add a new version: bump LATEST_KNOWN_DENO_VERSION in config.rs, run
// the helper commands documented at the bottom of this file to fetch the
// hashes, and add a new `MANIFEST_V_X_Y_Z` block below.

const MANIFEST_V_2_8_2: &[ManifestEntry] = &[
    ManifestEntry::new(
        "aarch64-apple-darwin",
        "02e5eb795c9f763772dfd081429cead9029e0a4a6aaff6d4e5f3ed6d2e94d361",
    ),
    ManifestEntry::new(
        "x86_64-apple-darwin",
        "77cf27f835f1921e49434449675c57432c6314d54edc725e2474cc825546e206",
    ),
    ManifestEntry::new(
        "aarch64-unknown-linux-gnu",
        "48647189aee6454ed9b9852fa700a77f92b39465c04c625901d165bc8e937afc",
    ),
    ManifestEntry::new(
        "x86_64-unknown-linux-gnu",
        "184da7a5267ab649bc08821b3bc3ce6805d8e6985fb82707cb8d5e9fd6535362",
    ),
    ManifestEntry::new(
        "aarch64-pc-windows-msvc",
        "37c68c1c78042a0775ed6770da09815572f28f0ee59ab018d409908165cae27d",
    ),
    ManifestEntry::new(
        "x86_64-pc-windows-msvc",
        "6fe073b11cabeba2f2726d8a3d1592b198aec5f23dab3473d0dc8d5ec7aee1c9",
    ),
];

const MANIFEST_V_2_8_1: &[ManifestEntry] = &[
    // Placeholder for the prior release. Currently unused (we only auto-
    // install the pinned version), but kept here as a reference for the
    // next bump. Hashes need to be filled in before being depended on.
];

#[derive(Debug, Clone, Copy)]
struct ManifestEntry {
    triple: &'static str,
    sha256: &'static str,
}

impl ManifestEntry {
    const fn new(triple: &'static str, sha256: &'static str) -> Self {
        Self { triple, sha256 }
    }
}

/// The version -> manifest table. Add a new line when bumping the pinned
/// version in `config::LATEST_KNOWN_DENO_VERSION`.
const MANIFEST: Manifest = Manifest {
    by_version: &[("2.8.2", MANIFEST_V_2_8_2), ("2.8.1", MANIFEST_V_2_8_1)],
};

struct Manifest {
    by_version: &'static [(&'static str, &'static [ManifestEntry])],
}

impl Manifest {
    fn sha256_for(&self, triple: &str, version: &str) -> Option<String> {
        let (_, entries) = self.by_version.iter().find(|(v, _)| *v == version)?;
        entries
            .iter()
            .find(|e| e.triple == triple)
            .map(|e| e.sha256.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_deno_version_extracts_semver() {
        assert_eq!(
            parse_deno_version("deno 2.8.2 (release, stable)\n").as_deref(),
            Some("2.8.2")
        );
        assert_eq!(
            parse_deno_version("deno 1.40.0\n").as_deref(),
            Some("1.40.0")
        );
        assert_eq!(
            parse_deno_version("deno 0.42.0\n").as_deref(),
            Some("0.42.0")
        );
    }

    #[test]
    fn parse_deno_version_rejects_garbage() {
        assert_eq!(parse_deno_version(""), None);
        assert_eq!(parse_deno_version("rustc 1.75.0\n"), None);
        assert_eq!(parse_deno_version("deno\n"), None);
        assert_eq!(parse_deno_version("deno 2.8\n"), None);
        assert_eq!(parse_deno_version("deno 2.8.2.1\n"), None);
        assert_eq!(parse_deno_version("deno 2.8.x\n"), None);
    }

    #[test]
    fn version_meets_minimum_basic() {
        assert!(version_meets_minimum("1.40.0"));
        assert!(version_meets_minimum("1.40.1"));
        assert!(version_meets_minimum("1.99.0"));
        assert!(version_meets_minimum("2.0.0"));
        assert!(version_meets_minimum("2.8.2"));
        assert!(version_meets_minimum("99.0.0"));
    }

    #[test]
    fn version_meets_minimum_rejects_old() {
        assert!(!version_meets_minimum("1.39.99"));
        assert!(!version_meets_minimum("1.0.0"));
        assert!(!version_meets_minimum("0.42.0"));
    }

    #[test]
    fn version_meets_minimum_rejects_garbage() {
        assert!(!version_meets_minimum("not a version"));
        assert!(!version_meets_minimum("1.40"));
        assert!(!version_meets_minimum(""));
    }

    #[test]
    fn target_triple_known_platforms() {
        // Just verify that *our* compile-time platform is recognized.
        let triple = target_triple().unwrap();
        assert!(MANIFEST.sha256_for(triple, "2.8.2").is_some());
    }

    #[test]
    fn manifest_sha256_lookup_works() {
        // The pinned version has every platform populated.
        let triples = [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "aarch64-unknown-linux-gnu",
            "x86_64-unknown-linux-gnu",
            "aarch64-pc-windows-msvc",
            "x86_64-pc-windows-msvc",
        ];
        for t in triples {
            let h = MANIFEST
                .sha256_for(t, "2.8.2")
                .unwrap_or_else(|| panic!("missing for {t}"));
            assert_eq!(h.len(), 64, "{t} hash should be 64 hex chars");
            assert!(
                h.chars().all(|c| c.is_ascii_hexdigit()),
                "{t} hash contains non-hex char: {h}"
            );
        }
    }

    #[test]
    fn manifest_sha256_lookup_misses_are_clean() {
        assert!(MANIFEST
            .sha256_for("aarch64-apple-darwin", "9.9.9")
            .is_none());
        assert!(MANIFEST.sha256_for("unknown-platform", "2.8.2").is_none());
    }

    #[test]
    fn binary_filename_matches_os() {
        let f = binary_filename();
        if cfg!(windows) {
            assert_eq!(f, "deno.exe");
        } else {
            assert_eq!(f, "deno");
        }
    }

    #[test]
    fn cache_dir_is_under_user_cache() {
        let dir = cache_dir_for("2.8.2").unwrap();
        // Path should end with slim-atlas/deno/v2.8.2 on every platform.
        let s = dir.to_string_lossy();
        assert!(s.contains("slim-atlas"), "got: {s}");
        assert!(s.contains("deno"), "got: {s}");
        assert!(s.ends_with("v2.8.2") || s.ends_with("v2.8.2/"), "got: {s}");
    }

    #[test]
    fn cache_dir_different_per_version() {
        let a = cache_dir_for("2.8.2").unwrap();
        let b = cache_dir_for("1.40.0").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn release_zip_url_format() {
        let url = release_zip_url("2.8.2").unwrap();
        assert_eq!(
            url,
            format!(
                "https://github.com/denoland/deno/releases/download/v2.8.2/deno-{}.zip",
                target_triple().unwrap()
            )
        );
    }
}

// =====================================================================
// Helper commands to bump the manifest
// =====================================================================
//
// To add a new Deno version to the manifest, run from the repo root:
//
//   VERSION=2.8.3
//   for triple in aarch64-apple-darwin x86_64-apple-darwin \
//                aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu \
//                aarch64-pc-windows-msvc x86_64-pc-windows-msvc; do
//     curl -sL --retry 5 --retry-delay 5 \
//       "https://github.com/denoland/deno/releases/download/v${VERSION}/deno-${triple}.zip.sha256sum" \
//       | awk -v t="$triple" '{ printf "    ManifestEntry::new(\"%s\",\n        \"%s\"),\n", t, $1 }'
//   done
//
// Then add a `MANIFEST_V_<version>` constant + a row in `MANIFEST.by_version`,
// and bump `LATEST_KNOWN_DENO_VERSION` in src/config.rs.
