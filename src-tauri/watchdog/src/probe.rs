//! Reads memory of the host and everything it spawned.
//!
//! On Windows the WebView2 processes and on Linux the WebKit processes descend from the
//! host. On macOS the WebKit content processes are started by launchd, so only the host
//! itself is visible there.

use crate::monitor::{ProcInfo, Snapshot};
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const MB: f64 = 1024.0 * 1024.0;

pub struct Probe {
    sys: Option<System>,
    host: Pid,
    me: Pid,
}

impl Probe {
    pub fn new(host_pid: u32) -> Self {
        Self {
            sys: System::new().ok(),
            host: Pid::from_u32(host_pid),
            me: Pid::from_u32(std::process::id()),
        }
    }

    pub fn snapshot(&mut self) -> Snapshot {
        let Some(sys) = self.sys.as_mut() else {
            // Without process information, assume the host is alive and let the pipe tell us otherwise
            return Snapshot { host_alive: true, ..Default::default() };
        };
        sys.refresh_memory();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );

        let procs = sys.processes();
        let host = procs.get(&self.host);
        let mut children_of: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, p) in procs {
            if p.thread_kind().is_some() {
                // Linux lists threads as tasks; they share the parent's memory
                continue;
            }
            if let Some(parent) = p.parent() {
                children_of.entry(parent).or_default().push(*pid);
            }
        }

        let mut children = Vec::new();
        let mut seen = HashSet::new();
        let mut queue = vec![self.host];
        while let Some(pid) = queue.pop() {
            for child in children_of.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
                if *child == self.me || !seen.insert(*child) {
                    continue;
                }
                if let Some(p) = procs.get(child) {
                    children.push(ProcInfo {
                        pid: child.as_u32(),
                        name: p.name().to_string_lossy().into_owned(),
                        rss_mb: p.memory() as f64 / MB,
                    });
                }
                queue.push(*child);
            }
        }

        Snapshot {
            host_alive: host.is_some(),
            host_rss_mb: host.map(|p| p.memory() as f64 / MB).unwrap_or(0.0),
            children,
            sys_total_mb: sys.total_memory() as f64 / MB,
            sys_avail_mb: sys.available_memory() as f64 / MB,
        }
    }
}
