//! The watchdog's decision logic, kept free of I/O and clocks so it can be unit tested.
//!
//! Inputs are heartbeats relayed from the webview, periodic process snapshots, and the
//! host's goodbye or disappearance. Outputs are reports to write and when to exit.

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};

pub struct Config {
    /// No heartbeat for this long while the page is visible means the renderer is stuck or gone.
    pub stall_visible_ms: u64,
    /// Hidden pages get their timers throttled, so they get much more slack.
    pub stall_hidden_ms: u64,
    /// A gap this long between our own ticks means the machine was asleep, not that the app hung.
    pub suspend_gap_ms: u64,
    pub max_samples: usize,
    /// Only processes at least this large count as a renderer that died.
    pub gone_min_rss_mb: f64,
    /// A process that vanished this long before the stall was noticed still explains it.
    pub gone_window_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            stall_visible_ms: 20_000,
            stall_hidden_ms: 300_000,
            suspend_gap_ms: 15_000,
            max_samples: 90,
            gone_min_rss_mb: 50.0,
            gone_window_ms: 30_000,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub rss_mb: f64,
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub host_alive: bool,
    pub host_rss_mb: f64,
    /// Every process descending from the host (webview browser, renderers, GPU, ...)
    pub children: Vec<ProcInfo>,
    pub sys_total_mb: f64,
    pub sys_avail_mb: f64,
}

#[derive(Debug)]
pub enum Action {
    Write { id: String, report: Value },
    Exit,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    /// Heartbeats stopped but no large process vanished: a hang, or a crash we could not see
    Unresponsive,
    /// Heartbeats stopped and a large webview process vanished around the same time
    RendererCrashed,
    /// The host process went away without saying goodbye, with no stall before it
    HostExited,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Unresponsive => "renderer-unresponsive",
            Kind::RendererCrashed => "renderer-crashed",
            Kind::HostExited => "host-exited",
        }
    }
}

struct Incident {
    id: String,
    kind: Kind,
    detected_wall: u64,
    detected_mono: u64,
    stall_ms: u64,
    visible: bool,
    host_exit: Option<&'static str>,
    resolved_after_ms: Option<u64>,
}

struct Gone {
    mono: u64,
    wall: u64,
    info: ProcInfo,
}

struct Sample {
    wall: u64,
    host_rss_mb: f64,
    children_rss_mb: f64,
    top: Vec<ProcInfo>,
    sys_avail_mb: f64,
    beat_age_ms: Option<u64>,
}

pub struct Monitor {
    cfg: Config,
    session: String,
    app_version: String,
    last_beat_mono: Option<u64>,
    last_beat: Value,
    visible: bool,
    last_tick_mono: Option<u64>,
    prev_children: HashMap<u32, ProcInfo>,
    gone: VecDeque<Gone>,
    samples: VecDeque<Sample>,
    sys_total_mb: f64,
    incident: Option<Incident>,
    seq: u32,
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

impl Monitor {
    pub fn new(cfg: Config, session: String, app_version: String) -> Self {
        Self {
            cfg,
            session,
            app_version,
            last_beat_mono: None,
            last_beat: Value::Null,
            visible: true,
            last_tick_mono: None,
            prev_children: HashMap::new(),
            gone: VecDeque::new(),
            samples: VecDeque::new(),
            sys_total_mb: 0.0,
            incident: None,
            seq: 0,
        }
    }

    pub fn beat(&mut self, mono: u64, _wall: u64, payload: Value) -> Vec<Action> {
        self.visible = payload.get("visible").and_then(Value::as_bool).unwrap_or(true);
        self.last_beat = payload;
        self.last_beat_mono = Some(mono);
        let mut actions = Vec::new();
        if let Some(mut inc) = self.incident.take() {
            // The page is talking again: it was a hang that recovered, or a reloaded renderer
            inc.resolved_after_ms = Some(mono.saturating_sub(inc.detected_mono) + inc.stall_ms);
            actions.push(self.write(&inc));
        }
        actions
    }

    pub fn tick(&mut self, mono: u64, wall: u64, snap: Snapshot) -> Vec<Action> {
        if let Some(prev) = self.last_tick_mono {
            if mono.saturating_sub(prev) > self.cfg.suspend_gap_ms && self.last_beat_mono.is_some() {
                // The machine slept; nothing could beat. Start counting again.
                self.last_beat_mono = Some(mono);
            }
        }
        self.last_tick_mono = Some(mono);
        self.sys_total_mb = snap.sys_total_mb;

        let current: HashMap<u32, ProcInfo> =
            snap.children.iter().map(|p| (p.pid, p.clone())).collect();
        let mut newly_gone = false;
        for (pid, info) in &self.prev_children {
            if !current.contains_key(pid) && info.rss_mb >= self.cfg.gone_min_rss_mb {
                newly_gone = true;
                self.gone.push_back(Gone { mono, wall, info: info.clone() });
                if self.gone.len() > 20 {
                    self.gone.pop_front();
                }
            }
        }
        self.prev_children = current;

        let mut top = snap.children.clone();
        top.sort_by(|a, b| b.rss_mb.partial_cmp(&a.rss_mb).unwrap_or(std::cmp::Ordering::Equal));
        top.truncate(5);
        self.samples.push_back(Sample {
            wall,
            host_rss_mb: snap.host_rss_mb,
            children_rss_mb: snap.children.iter().map(|p| p.rss_mb).sum(),
            top,
            sys_avail_mb: snap.sys_avail_mb,
            beat_age_ms: self.last_beat_mono.map(|b| mono.saturating_sub(b)),
        });
        while self.samples.len() > self.cfg.max_samples {
            self.samples.pop_front();
        }

        if !snap.host_alive {
            return self.host_gone(mono, wall);
        }

        let mut actions = Vec::new();
        if let Some(mut inc) = self.incident.take() {
            if inc.kind == Kind::Unresponsive && newly_gone {
                inc.kind = Kind::RendererCrashed;
                actions.push(self.write(&inc));
            }
            self.incident = Some(inc);
        } else if let Some(last) = self.last_beat_mono {
            let age = mono.saturating_sub(last);
            let limit = if self.visible { self.cfg.stall_visible_ms } else { self.cfg.stall_hidden_ms };
            if age > limit {
                let since = mono.saturating_sub(age + self.cfg.gone_window_ms);
                let kind = if self.gone.iter().any(|g| g.mono >= since) {
                    Kind::RendererCrashed
                } else {
                    Kind::Unresponsive
                };
                let inc = self.open(kind, mono, wall, age);
                actions.push(self.write(&inc));
                self.incident = Some(inc);
            }
        }
        actions
    }

    /// The host said goodbye: a normal exit.
    pub fn bye(&mut self, _mono: u64, _wall: u64) -> Vec<Action> {
        let mut actions = Vec::new();
        if let Some(mut inc) = self.incident.take() {
            inc.host_exit = Some("clean");
            actions.push(self.write(&inc));
        }
        actions.push(Action::Exit);
        actions
    }

    /// The host's pipe closed or the process vanished without a goodbye.
    pub fn host_gone(&mut self, mono: u64, wall: u64) -> Vec<Action> {
        let inc = match self.incident.take() {
            Some(mut inc) => {
                inc.host_exit = Some("unexpected");
                inc
            }
            None => {
                let age = self.last_beat_mono.map(|b| mono.saturating_sub(b)).unwrap_or(0);
                let mut inc = self.open(Kind::HostExited, mono, wall, age);
                inc.host_exit = Some("unexpected");
                inc
            }
        };
        vec![self.write(&inc), Action::Exit]
    }

    fn open(&mut self, kind: Kind, mono: u64, wall: u64, stall_ms: u64) -> Incident {
        self.seq += 1;
        Incident {
            id: format!("{}-{}", wall, self.seq),
            kind,
            detected_wall: wall,
            detected_mono: mono,
            stall_ms,
            visible: self.visible,
            host_exit: None,
            resolved_after_ms: None,
        }
    }

    fn write(&self, inc: &Incident) -> Action {
        let proc_json = |p: &ProcInfo| json!({ "pid": p.pid, "name": p.name, "rssMB": round1(p.rss_mb) });
        let samples: Vec<Value> = self
            .samples
            .iter()
            .map(|s| {
                json!({
                    "at": s.wall,
                    "hostRssMB": round1(s.host_rss_mb),
                    "childrenRssMB": round1(s.children_rss_mb),
                    "top": s.top.iter().map(proc_json).collect::<Vec<_>>(),
                    "sysAvailMB": round1(s.sys_avail_mb),
                    "beatAgeMs": s.beat_age_ms,
                })
            })
            .collect();
        let gone: Vec<Value> = self
            .gone
            .iter()
            .map(|g| {
                let mut v = proc_json(&g.info);
                v["at"] = json!(g.wall);
                v
            })
            .collect();
        let report = json!({
            "v": 1,
            "generator": "risuai-watchdog",
            "id": inc.id,
            "session": self.session,
            "kind": inc.kind.as_str(),
            "detectedAt": inc.detected_wall,
            "stallMs": inc.stall_ms,
            "visible": inc.visible,
            "resolved": inc.resolved_after_ms.is_some(),
            "resolvedAfterMs": inc.resolved_after_ms,
            "hostExit": inc.host_exit,
            "appVersion": self.app_version,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "sysTotalMB": round1(self.sys_total_mb),
            "lastBeat": self.last_beat,
            "goneProcesses": gone,
            "samples": samples,
        });
        Action::Write { id: inc.id.clone(), report }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, rss_mb: f64) -> ProcInfo {
        ProcInfo { pid, name: format!("p{pid}"), rss_mb }
    }

    fn snap(children: Vec<ProcInfo>) -> Snapshot {
        Snapshot { host_alive: true, host_rss_mb: 100.0, children, sys_total_mb: 16000.0, sys_avail_mb: 8000.0 }
    }

    fn monitor() -> Monitor {
        Monitor::new(Config::default(), "s".into(), "test".into())
    }

    fn written(actions: &[Action]) -> Vec<&Value> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Write { report, .. } => Some(report),
                Action::Exit => None,
            })
            .collect()
    }

    fn exits(actions: &[Action]) -> bool {
        actions.iter().any(|a| matches!(a, Action::Exit))
    }

    #[test]
    fn no_report_before_the_first_heartbeat() {
        let mut m = monitor();
        for i in 0..60 {
            assert!(m.tick(i * 2000, 0, snap(vec![])).is_empty());
        }
    }

    #[test]
    fn steady_heartbeats_report_nothing_and_goodbye_exits_quietly() {
        let mut m = monitor();
        for i in 0..30u64 {
            m.beat(i * 2000, 0, json!({ "visible": true }));
            assert!(m.tick(i * 2000 + 1000, 0, snap(vec![proc(2, 300.0)])).is_empty());
        }
        let actions = m.bye(61_000, 0);
        assert!(written(&actions).is_empty());
        assert!(exits(&actions));
    }

    #[test]
    fn a_stall_without_a_vanished_process_is_unresponsive_and_can_recover() {
        let mut m = monitor();
        m.beat(0, 0, json!({ "visible": true }));
        let mut t = 0;
        let mut reports = vec![];
        while reports.is_empty() {
            t += 2000;
            reports = m.tick(t, t, snap(vec![proc(2, 300.0)]));
        }
        let r = written(&reports)[0];
        assert_eq!(r["kind"], "renderer-unresponsive");
        assert!(t > 20_000 && t <= 22_000);

        let recovered = m.beat(t + 5000, 0, json!({ "visible": true }));
        let r = written(&recovered)[0];
        assert_eq!(r["resolved"], true);
        assert_eq!(r["kind"], "renderer-unresponsive");
    }

    #[test]
    fn a_large_process_vanishing_makes_it_a_renderer_crash() {
        let mut m = monitor();
        m.beat(0, 0, json!({ "visible": true, "activity": ["chat:send"] }));
        m.tick(2000, 2000, snap(vec![proc(2, 3900.0), proc(3, 20.0)]));
        // the renderer dies; the small helper process is not interesting
        m.tick(4000, 4000, snap(vec![proc(3, 20.0)]));
        let mut t = 4000;
        let mut actions = vec![];
        while actions.is_empty() {
            t += 2000;
            actions = m.tick(t, t, snap(vec![proc(3, 20.0)]));
        }
        let r = written(&actions)[0];
        assert_eq!(r["kind"], "renderer-crashed");
        assert_eq!(r["goneProcesses"][0]["pid"], 2);
        assert_eq!(r["goneProcesses"][0]["rssMB"], 3900.0);
        assert_eq!(r["lastBeat"]["activity"][0], "chat:send");
    }

    #[test]
    fn an_unresponsive_incident_is_upgraded_when_the_renderer_dies_later() {
        let mut m = monitor();
        m.beat(0, 0, json!({ "visible": true }));
        let mut t = 0;
        while written(&m.tick(t + 2000, t, snap(vec![proc(2, 3000.0)]))).is_empty() {
            t += 2000;
        }
        let actions = m.tick(t + 4000, t, snap(vec![]));
        assert_eq!(written(&actions)[0]["kind"], "renderer-crashed");
    }

    #[test]
    fn small_processes_vanishing_do_not_count() {
        let mut m = monitor();
        m.beat(0, 0, json!({ "visible": true }));
        m.tick(2000, 0, snap(vec![proc(5, 10.0)]));
        m.tick(4000, 0, snap(vec![]));
        let mut t = 4000;
        let mut actions = vec![];
        while actions.is_empty() {
            t += 2000;
            actions = m.tick(t, 0, snap(vec![]));
        }
        assert_eq!(written(&actions)[0]["kind"], "renderer-unresponsive");
    }

    #[test]
    fn hidden_pages_get_more_slack() {
        let mut m = monitor();
        m.beat(0, 0, json!({ "visible": false }));
        for i in 1..=100u64 {
            assert!(m.tick(i * 2000, 0, snap(vec![])).is_empty(), "reported at {}ms", i * 2000);
        }
    }

    #[test]
    fn sleep_is_not_a_hang() {
        let mut m = monitor();
        m.beat(0, 0, json!({ "visible": true }));
        m.tick(2000, 0, snap(vec![]));
        // the laptop sleeps for an hour; the first tick after waking sees a huge gap
        assert!(m.tick(3_602_000, 0, snap(vec![])).is_empty());
        assert!(m.tick(3_604_000, 0, snap(vec![])).is_empty());
    }

    #[test]
    fn host_vanishing_without_goodbye_is_reported() {
        let mut m = monitor();
        m.beat(0, 0, json!({ "visible": true }));
        let actions = m.host_gone(1000, 0);
        let r = written(&actions)[0];
        assert_eq!(r["kind"], "host-exited");
        assert_eq!(r["hostExit"], "unexpected");
        assert!(exits(&actions));
    }

    #[test]
    fn closing_the_app_during_a_hang_keeps_the_hang() {
        let mut m = monitor();
        m.beat(0, 0, json!({ "visible": true }));
        let mut t = 0;
        while written(&m.tick(t + 2000, t, snap(vec![]))).is_empty() {
            t += 2000;
        }
        let actions = m.host_gone(t + 10_000, 0);
        let r = written(&actions)[0];
        assert_eq!(r["kind"], "renderer-unresponsive");
        assert_eq!(r["hostExit"], "unexpected");
        assert_eq!(r["resolved"], false);
    }

    #[test]
    fn samples_are_capped() {
        let mut m = monitor();
        for i in 0..500u64 {
            m.tick(i * 2000, 0, snap(vec![]));
        }
        assert_eq!(m.samples.len(), Config::default().max_samples);
    }
}
