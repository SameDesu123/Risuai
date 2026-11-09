import { invoke } from "@tauri-apps/api/core"
import { getBlackboxLiveState, markBlackboxCleanExit } from "./blackbox"
import { isTauri } from "./platform"

/**
 * The page's side of the desktop watchdog (src-tauri/watchdog), a separate process that
 * notices when the webview stops answering or its renderer dies, and keeps a report.
 */

const BEAT_INTERVAL_MS = 5_000
const REPORTS_KEY = 'risu_watchdog_reports'
const MAX_STORED_REPORTS = 10

export type WatchdogKind = 'renderer-unresponsive' | 'renderer-crashed' | 'host-exited'

export interface WatchdogReport {
    id: string
    session: string
    kind: WatchdogKind
    detectedAt: number
    stallMs: number
    visible: boolean
    resolved: boolean
    resolvedAfterMs: number | null
    hostExit: 'clean' | 'unexpected' | null
    notified?: boolean
    [key: string]: unknown
}

export interface WatchdogLastSession {
    session: string
    /** "running" means the watchdog itself was killed, so how the app ended is unknown */
    exit: 'clean' | 'unexpected' | 'running'
    at: number
}

let beating = false

function beat() {
    invoke('watchdog_beat', { payload: getBlackboxLiveState() }).catch(() => { })
}

/**
 * Starts sending heartbeats. Without them the watchdog never reports a stall,
 * so a page that never gets here is only noticed if the whole app goes away.
 */
export function startWatchdogBeats() {
    if (!isTauri || beating) {
        return
    }
    beating = true
    beat()
    setInterval(beat, BEAT_INTERVAL_MS)
    // Tell it at once, so it switches to the hidden page's longer allowance before timers slow down
    document.addEventListener('visibilitychange', beat)
}

/**
 * Call right before the app quits or relaunches itself, so neither recorder takes it for a crash.
 */
export async function prepareAppExit() {
    markBlackboxCleanExit()
    if (isTauri) {
        try {
            await invoke('watchdog_stop')
        } catch { }
    }
}

export function getWatchdogReports(): WatchdogReport[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(REPORTS_KEY) ?? '[]')
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function saveWatchdogReports(reports: WatchdogReport[]) {
    let list = reports.slice(-MAX_STORED_REPORTS)
    while (list.length > 0) {
        try {
            localStorage.setItem(REPORTS_KEY, JSON.stringify(list))
            return
        } catch {
            // Quota: drop the oldest and retry
            list = list.slice(1)
        }
    }
    try {
        localStorage.removeItem(REPORTS_KEY)
    } catch { }
}

export function markWatchdogReportsNotified() {
    saveWatchdogReports(getWatchdogReports().map((r) => ({ ...r, notified: true })))
}

export function clearWatchdogReports() {
    try {
        localStorage.removeItem(REPORTS_KEY)
    } catch { }
}

/**
 * Whether a report is worth interrupting the user for: the renderer died, or it froze
 * and never came back. Host exits without a stall are usually the app being killed
 * from outside, so they are only kept.
 */
export function isWatchdogReportAlarming(report: WatchdogReport) {
    return report.kind === 'renderer-crashed' || (report.kind === 'renderer-unresponsive' && !report.resolved)
}

/**
 * Moves the reports of earlier sessions from the watchdog's folder into localStorage,
 * and returns how the previous session ended. Returns null outside the desktop app.
 */
export async function collectWatchdogReports(): Promise<{
    enabled: boolean
    previousSession: WatchdogLastSession | null
    newReports: WatchdogReport[]
} | null> {
    if (!isTauri) {
        return null
    }
    const result = await invoke<{
        enabled: boolean
        previousSession: WatchdogLastSession | null
        reports: WatchdogReport[]
    }>('watchdog_take_reports')
    const newReports = (result.reports ?? []).map((r) => ({ ...r, notified: false }))
    if (newReports.length > 0) {
        saveWatchdogReports([...getWatchdogReports(), ...newReports])
    }
    return { enabled: result.enabled, previousSession: result.previousSession, newReports }
}
