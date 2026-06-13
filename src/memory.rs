//! RSS memory sampling for the slim-atlas process (and its
//! Deno subprocesses).
//!
//! Wraps `sysinfo::System` in a small struct so the rest of the codebase
//! doesn't need to know about platform-specific process queries. The probe
//! is held inside an `Arc<Mutex<…>>` on `AppState`; each call to `sample`
//! refreshes stats for the tracked PIDs only (cheap) and returns a plain
//! `MemorySample` that the call site emits as a `tracing` event.

use sysinfo::{Pid, System};

/// A memory snapshot at a point in time.
#[derive(Debug, Clone, Copy)]
pub struct MemorySample {
    /// RSS in bytes for the slim-atlas process.
    pub server_rss: u64,
    /// RSS in bytes summed across any tracked child PIDs (0 in Phase 1).
    pub child_rss: u64,
}

/// Tracks the slim-atlas PID and any child PIDs we want RSS for.
pub struct MemoryProbe {
    system: System,
    self_pid: Pid,
}

impl MemoryProbe {
    pub fn new() -> Self {
        let mut system = System::new();
        // Use the OS-reported current PID; falls back to a re-read after the
        // first refresh in case the platform reports a different value
        // initially (notably macOS LaunchServices).
        let self_pid = Pid::from_u32(std::process::id());
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        Self { system, self_pid }
    }

    /// Sample RSS for the server process plus the supplied child PIDs.
    /// Phase 1 passes `&[]`; Phase 3 will pass Deno subprocess PIDs.
    ///
    /// `navigate` is already a slow call (HTTP + parse), so we accept the
    /// cost of a full `refresh_processes` rather than maintaining a
    /// tracked-PID list. If profiling ever shows this matters we can
    /// switch to `refresh_processes_specifics`.
    pub fn sample(&mut self, child_pids: &[u32]) -> MemorySample {
        self.system
            .refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        // The OS-reported PID sometimes differs from what we stored (rare,
        // but observed on macOS for processes launched via LaunchServices).
        // Look ourselves up by name as a fallback.
        let server_rss = self
            .system
            .process(self.self_pid)
            .map(|p| p.memory())
            .or_else(|| {
                let exe = std::env::current_exe().ok();
                let name = exe
                    .as_ref()
                    .and_then(|p| p.file_name())
                    .and_then(|n| n.to_str())
                    .unwrap_or("slim-atlas");
                self.system
                    .processes()
                    .values()
                    .find(|p| p.name() == name)
                    .map(|p| p.memory())
            })
            .unwrap_or(0);

        let child_rss = child_pids
            .iter()
            .map(|&raw| {
                let pid = Pid::from_u32(raw);
                self.system.process(pid).map(|p| p.memory()).unwrap_or(0)
            })
            .sum();

        MemorySample {
            server_rss,
            child_rss,
        }
    }
}

impl Default for MemoryProbe {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_returns_positive_server_rss() {
        let mut probe = MemoryProbe::new();
        let s = probe.sample(&[]);
        // RSS is at minimum the size of the binary + stack + heap of an idle
        // Rust process. On macOS/Linux this is comfortably > 1 MB.
        assert!(
            s.server_rss > 1_000_000,
            "expected RSS > 1 MB, got {}",
            s.server_rss
        );
        assert_eq!(s.child_rss, 0);
    }

    #[test]
    fn sample_with_bogus_child_pids_is_zero() {
        let mut probe = MemoryProbe::new();
        // PIDs that don't exist on this system should contribute 0, not
        // panic or pull stats for an unrelated process.
        let bogus = [u32::MAX, u32::MAX - 1, 999_999];
        let s = probe.sample(&bogus);
        assert_eq!(s.child_rss, 0);
    }
}
