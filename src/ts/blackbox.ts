/**
 * Blackbox: a small flight recorder that survives tab crashes.
 *
 * A crashed renderer (OOM, hang) cannot report anything about itself, so this
 * module keeps a rolling record of cheap, content-free metrics and breadcrumbs
 * in localStorage while the app runs. On the next start, records left behind
 * by tabs that did not shut down cleanly are turned into crash reports that
 * the user can export.
 *
 * The record never contains chat text, character names, prompts or URLs:
 * only numbers and fixed labels passed to blackboxCrumb/blackboxActivity.
 *
 * This file must stay free of app imports (database, stores, alert, ...),
 * because alert.ts and other low-level modules import it.
 */

export const BLACKBOX_RECORD_PREFIX = 'risu_blackbox:'
export const BLACKBOX_REPORTS_KEY = 'risu_blackbox_reports'
export const BLACKBOX_TAB_KEY = 'risu_blackbox_tab'
export const BLACKBOX_DISABLED_KEY = 'risu_blackbox_disabled'

const SAMPLE_INTERVAL_MS = 10_000
const MAX_SAMPLES = 60
const MAX_CRUMBS = 100
const MAX_REPORTS = 5
const CRUMB_FLUSH_THROTTLE_MS = 1_000
const UA_MEMORY_EVERY_N_TICKS = 6
/** Without the Web Locks API, a record this old with no clean exit is treated as dead. */
export const HEURISTIC_DEAD_MS = 3 * 60_000

export interface BlackboxSample {
    /** ms since the session started */
    t: number
    visible: boolean
    heapUsedMB?: number
    heapTotalMB?: number
    /** measureUserAgentSpecificMemory total, only when crossOriginIsolated */
    uaMemoryMB?: number
    domNodes: number
    images: number
    /** Upper-bound estimate of decoded image memory (w * h * 4 for every loaded <img>) */
    imageEstMB: number
    canvasMB: number
    iframes: number
    /** How late this sample's timer fired; large values mean the main thread was blocked */
    lagMs: number
    activity: string[]
    counters: Record<string, number>
}

export interface BlackboxCrumb {
    /** ms since the session started */
    t: number
    label: string
}

export interface BlackboxMeta {
    appVersion: string
    userAgent: string
    deviceMemoryGB?: number
    cores?: number
    heapLimitMB?: number
    crossOriginIsolated: boolean
}

export interface BlackboxRecord {
    v: 1
    id: string
    /** epoch ms */
    startedAt: number
    /** epoch ms */
    lastWrite: number
    clean: boolean
    visible: boolean
    meta: BlackboxMeta
    samples: BlackboxSample[]
    crumbs: BlackboxCrumb[]
}

export type BlackboxVerdict = 'crashed-while-visible' | 'killed-in-background'

export interface BlackboxReport {
    v: 1
    /** epoch ms */
    detectedAt: number
    verdict: BlackboxVerdict
    /** How the dead session was told apart from a live one */
    liveness: 'locks' | 'heuristic'
    /** The crashed session ran in the same tab that is now starting (reload after crash) */
    sameTab: boolean
    /** document.wasDiscarded of the starting tab; only meaningful when sameTab */
    wasDiscarded: boolean | null
    navigationType: string | null
    /** heapUsed / heapLimit of the last sample, when the browser exposes it */
    lastHeapRatio: number | null
    /** The user was already asked about this report */
    notified: boolean
    record: BlackboxRecord
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

export function pushRing<T>(arr: T[], item: T, max: number) {
    arr.push(item)
    if (arr.length > max) {
        arr.splice(0, arr.length - max)
    }
}

export function blackboxLockName(id: string) {
    return BLACKBOX_RECORD_PREFIX + id
}

/**
 * Picks the records whose sessions ended without a clean exit and are no longer running.
 */
export function findDeadRecords(arg: {
    records: BlackboxRecord[]
    currentId: string
    now: number
    /** Names of currently held Web Locks, or null when the API is unavailable */
    heldLocks: Set<string> | null
}): BlackboxRecord[] {
    return arg.records.filter((r) => {
        if (r.clean || r.id === arg.currentId) {
            return false
        }
        if (arg.heldLocks) {
            return !arg.heldLocks.has(blackboxLockName(r.id))
        }
        return arg.now - r.lastWrite > HEURISTIC_DEAD_MS
    })
}

export function buildBlackboxReport(record: BlackboxRecord, ctx: {
    now: number
    liveness: 'locks' | 'heuristic'
    prevTabId: string | null
    wasDiscarded: boolean | null
    navigationType: string | null
}): BlackboxReport {
    const sameTab = ctx.prevTabId !== null && ctx.prevTabId === record.id
    const last = record.samples.at(-1)
    const limit = record.meta.heapLimitMB
    const lastHeapRatio = last?.heapUsedMB !== undefined && limit
        ? Math.round((last.heapUsedMB / limit) * 1000) / 1000
        : null
    return {
        v: 1,
        detectedAt: ctx.now,
        verdict: record.visible ? 'crashed-while-visible' : 'killed-in-background',
        liveness: ctx.liveness,
        sameTab,
        wasDiscarded: sameTab ? ctx.wasDiscarded : null,
        navigationType: sameTab ? ctx.navigationType : null,
        lastHeapRatio,
        notified: false,
        record,
    }
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

let record: BlackboxRecord | null = null
let sessionStart = 0
let started: Promise<void> | null = null
let lastFlush = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null
let lastTick = 0
let tickCount = 0
let uaMemoryInFlight = false
let lastUaMemoryMB: number | undefined = undefined
const activity: string[] = []
const counters = new Map<string, () => number>()

function storage(): Storage | null {
    try {
        return globalThis.localStorage ?? null
    } catch {
        return null
    }
}

function mb(bytes: number) {
    return Math.round(bytes / 1024 / 1024 * 10) / 10
}

function elapsed() {
    return Math.round(performance.now() - sessionStart)
}

function newId() {
    try {
        return crypto.randomUUID()
    } catch {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    }
}

function readHeap() {
    const m = (performance as any).memory
    if (!m || typeof m.usedJSHeapSize !== 'number') {
        return null
    }
    return {
        used: mb(m.usedJSHeapSize),
        total: mb(m.totalJSHeapSize),
        limit: mb(m.jsHeapSizeLimit),
    }
}

function writeRecord(force = false) {
    const ls = storage()
    if (!record || !ls) {
        return
    }
    if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
    }
    record.lastWrite = Date.now()
    lastFlush = record.lastWrite
    const key = BLACKBOX_RECORD_PREFIX + record.id
    try {
        ls.setItem(key, JSON.stringify(record))
    } catch {
        // Likely quota: keep the newest half and try once more
        record.samples.splice(0, Math.ceil(record.samples.length / 2))
        record.crumbs.splice(0, Math.ceil(record.crumbs.length / 2))
        if (force) {
            try {
                ls.setItem(key, JSON.stringify(record))
            } catch { }
        }
    }
}

function scheduleFlush() {
    if (!record || flushTimer) {
        return
    }
    const wait = Math.max(0, CRUMB_FLUSH_THROTTLE_MS - (Date.now() - lastFlush))
    if (wait === 0) {
        writeRecord()
        return
    }
    flushTimer = setTimeout(() => {
        flushTimer = null
        writeRecord()
    }, wait)
}

function takeSample(lagMs: number): BlackboxSample {
    const heap = readHeap()
    let images = 0
    let imageBytes = 0
    for (const img of Array.from(document.images)) {
        if (img.complete && img.naturalWidth > 0) {
            images++
            imageBytes += img.naturalWidth * img.naturalHeight * 4
        }
    }
    let canvasBytes = 0
    for (const c of Array.from(document.getElementsByTagName('canvas'))) {
        canvasBytes += c.width * c.height * 4
    }
    const counterValues: Record<string, number> = {}
    for (const [name, fn] of counters) {
        try {
            const v = fn()
            if (typeof v === 'number' && Number.isFinite(v)) {
                counterValues[name] = v
            }
        } catch { }
    }
    return {
        t: elapsed(),
        visible: document.visibilityState === 'visible',
        heapUsedMB: heap?.used,
        heapTotalMB: heap?.total,
        uaMemoryMB: lastUaMemoryMB,
        domNodes: document.getElementsByTagName('*').length,
        images,
        imageEstMB: mb(imageBytes),
        canvasMB: mb(canvasBytes),
        iframes: document.getElementsByTagName('iframe').length,
        lagMs,
        activity: [...activity],
        counters: counterValues,
    }
}

function measureUaMemory() {
    const measure = (performance as any).measureUserAgentSpecificMemory
    if (uaMemoryInFlight || !globalThis.crossOriginIsolated || typeof measure !== 'function') {
        return
    }
    uaMemoryInFlight = true
    Promise.resolve(measure.call(performance)).then((r: any) => {
        if (typeof r?.bytes === 'number') {
            lastUaMemoryMB = mb(r.bytes)
        }
    }).catch(() => { }).finally(() => {
        uaMemoryInFlight = false
    })
}

function tick() {
    if (!record) {
        return
    }
    const now = performance.now()
    const visible = document.visibilityState === 'visible'
    // Hidden tabs get their timers throttled, so lateness only means something while visible.
    // visibilitychange resets lastTick, so a freshly shown tab does not report the hidden gap as lag.
    const lagMs = visible
        ? Math.max(0, Math.round(now - lastTick - SAMPLE_INTERVAL_MS))
        : 0
    lastTick = now
    tickCount++
    record.visible = visible
    if (visible) {
        if (tickCount % UA_MEMORY_EVERY_N_TICKS === 0) {
            measureUaMemory()
        }
        try {
            pushRing(record.samples, takeSample(lagMs), MAX_SAMPLES)
        } catch { }
    }
    // Also written while hidden, as a heartbeat for the no-Web-Locks fallback
    writeRecord()
}

function readAllRecords(ls: Storage): BlackboxRecord[] {
    const out: BlackboxRecord[] = []
    for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i)
        if (!key?.startsWith(BLACKBOX_RECORD_PREFIX)) {
            continue
        }
        try {
            const r = JSON.parse(ls.getItem(key) ?? 'null')
            if (r?.v === 1 && typeof r.id === 'string') {
                out.push(r)
            } else {
                ls.removeItem(key)
                i--
            }
        } catch {
            ls.removeItem(key)
            i--
        }
    }
    return out
}

export function getBlackboxReports(): BlackboxReport[] {
    const ls = storage()
    if (!ls) {
        return []
    }
    try {
        const parsed = JSON.parse(ls.getItem(BLACKBOX_REPORTS_KEY) ?? '[]')
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

function saveBlackboxReports(reports: BlackboxReport[]) {
    const ls = storage()
    if (!ls) {
        return
    }
    const trimmed = reports.slice(-MAX_REPORTS)
    try {
        ls.setItem(BLACKBOX_REPORTS_KEY, JSON.stringify(trimmed))
    } catch {
        // Quota: keep only the newest report
        try {
            ls.setItem(BLACKBOX_REPORTS_KEY, JSON.stringify(trimmed.slice(-1)))
        } catch { }
    }
}

export function markBlackboxReportsNotified() {
    const reports = getBlackboxReports()
    for (const r of reports) {
        r.notified = true
    }
    saveBlackboxReports(reports)
}

export function clearBlackboxReports() {
    storage()?.removeItem(BLACKBOX_REPORTS_KEY)
}

async function collectPreviousSessions(ls: Storage, prevTabId: string | null) {
    const locks = (navigator as any).locks
    let heldLocks: Set<string> | null = null
    if (locks?.query) {
        try {
            const snapshot = await locks.query()
            heldLocks = new Set((snapshot.held ?? []).map((l: { name: string }) => l.name))
        } catch {
            heldLocks = null
        }
    }
    const records = readAllRecords(ls)
    const now = Date.now()
    const dead = findDeadRecords({
        records,
        currentId: record?.id ?? '',
        now,
        heldLocks,
    })
    let navigationType: string | null = null
    try {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
        navigationType = nav?.type ?? null
    } catch { }
    const wasDiscarded = typeof (document as any).wasDiscarded === 'boolean'
        ? (document as any).wasDiscarded
        : null

    if (dead.length > 0) {
        const reports = getBlackboxReports()
        for (const r of dead) {
            reports.push(buildBlackboxReport(r, {
                now,
                liveness: heldLocks ? 'locks' : 'heuristic',
                prevTabId,
                wasDiscarded,
                navigationType,
            }))
        }
        saveBlackboxReports(reports)
    }

    // Remove dead records (now reports) and records of tabs that closed cleanly
    for (const r of records) {
        if (r.id === record?.id) {
            continue
        }
        if (r.clean || dead.includes(r)) {
            ls.removeItem(BLACKBOX_RECORD_PREFIX + r.id)
        }
    }
}

/**
 * Starts recording for this tab and turns dead sessions into reports.
 * Safe to call more than once; resolves once previous sessions are collected.
 */
export function startBlackbox(appVersion: string): Promise<void> {
    if (started) {
        return started
    }
    started = (async () => {
        const ls = storage()
        if (!ls || typeof document === 'undefined' || ls.getItem(BLACKBOX_DISABLED_KEY) === 'true') {
            return
        }
        sessionStart = performance.now()
        lastTick = sessionStart

        let prevTabId: string | null = null
        try {
            prevTabId = sessionStorage.getItem(BLACKBOX_TAB_KEY)
        } catch { }
        const id = newId()
        try {
            sessionStorage.setItem(BLACKBOX_TAB_KEY, id)
        } catch { }

        const heap = readHeap()
        const nav = navigator as any
        record = {
            v: 1,
            id,
            startedAt: Date.now(),
            lastWrite: Date.now(),
            clean: false,
            visible: document.visibilityState === 'visible',
            meta: {
                appVersion,
                userAgent: navigator.userAgent,
                deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
                cores: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : undefined,
                heapLimitMB: heap?.limit,
                crossOriginIsolated: !!globalThis.crossOriginIsolated,
            },
            samples: [],
            crumbs: [{ t: 0, label: 'boot:start' }],
        }

        // Hold a lock for the lifetime of this tab. The browser releases it when the
        // tab dies for any reason, which is how other tabs tell dead from alive.
        // The record is only written once the lock is held, so another tab that is
        // starting at the same moment never mistakes this one for a dead session.
        const locks = nav.locks
        if (locks?.request) {
            await new Promise<void>((granted) => {
                try {
                    locks.request(blackboxLockName(id), () => {
                        granted()
                        return new Promise(() => { })
                    }).catch(() => granted())
                } catch {
                    granted()
                }
            })
        }
        writeRecord(true)

        try {
            await collectPreviousSessions(ls, prevTabId)
        } catch (error) {
            console.error('[blackbox] failed to collect previous sessions', error)
        }

        setInterval(tick, SAMPLE_INTERVAL_MS)

        document.addEventListener('visibilitychange', () => {
            if (!record) {
                return
            }
            record.visible = document.visibilityState === 'visible'
            lastTick = performance.now()
            pushRing(record.crumbs, { t: elapsed(), label: record.visible ? 'page:visible' : 'page:hidden' }, MAX_CRUMBS)
            writeRecord(true)
        })
        addEventListener('pagehide', () => {
            if (!record) {
                return
            }
            record.clean = true
            pushRing(record.crumbs, { t: elapsed(), label: 'page:exit' }, MAX_CRUMBS)
            writeRecord(true)
        })
        addEventListener('pageshow', (e: PageTransitionEvent) => {
            if (!record || !e.persisted) {
                return
            }
            // Restored from the back/forward cache: running again
            record.clean = false
            pushRing(record.crumbs, { t: elapsed(), label: 'page:restore' }, MAX_CRUMBS)
            writeRecord(true)
        })
    })()
    return started
}

/**
 * Adds a breadcrumb. Labels must be fixed strings or numbers, never user content.
 */
export function blackboxCrumb(label: string, flushNow = false) {
    if (!record) {
        return
    }
    pushRing(record.crumbs, { t: elapsed(), label: label.slice(0, 120) }, MAX_CRUMBS)
    if (flushNow) {
        writeRecord(true)
    } else {
        scheduleFlush()
    }
}

/**
 * Runs fn as a named activity: it shows up in every sample taken meanwhile,
 * and its start and end are recorded as breadcrumbs.
 */
export async function blackboxActivity<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const begin = performance.now()
    activity.push(label)
    blackboxCrumb(`>${label}`, true)
    try {
        return await fn()
    } finally {
        const i = activity.lastIndexOf(label)
        if (i !== -1) {
            activity.splice(i, 1)
        }
        blackboxCrumb(`<${label} ${Math.round(performance.now() - begin)}ms`)
    }
}

/**
 * Registers a numeric counter that is recorded with every sample.
 * fn must be cheap: it runs every few seconds on the main thread.
 */
export function registerBlackboxCounter(name: string, fn: () => number) {
    counters.set(name, fn)
}

/**
 * A small summary of what the page is doing right now, for heartbeats to an outside watchdog.
 */
export function getBlackboxLiveState() {
    const heap = readHeap()
    const values: Record<string, number> = {}
    for (const [name, fn] of counters) {
        try {
            values[name] = fn()
        } catch { }
    }
    return {
        visible: typeof document === 'undefined' || document.visibilityState === 'visible',
        activity: [...activity],
        heapUsedMB: heap?.used,
        heapLimitMB: heap?.limit,
        counters: values,
        crumbs: record ? record.crumbs.slice(-5).map((c) => c.label) : [],
    }
}

/**
 * Marks this session as ended on purpose, for exits that may not fire pagehide
 * (such as relaunching the desktop app).
 */
export function markBlackboxCleanExit() {
    if (!record) {
        return
    }
    record.clean = true
    pushRing(record.crumbs, { t: elapsed(), label: 'app:exit' }, MAX_CRUMBS)
    writeRecord(true)
}
