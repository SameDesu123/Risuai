import type { Database } from '../storage/database.svelte'

type StreamChunk = Record<string, string>

export type SmoothStreamingConflict = 'responseStreamingOff' | 'streamingDisplayOptimizationOn'

/**
 * Settings that prevent smooth streaming from working.
 * Shared by the settings UI (to show a warning and disable the toggle)
 * and the chat pipeline (to skip smoothing), so both always agree.
 */
export function getSmoothStreamingConflicts(db: Database): SmoothStreamingConflict[] {
    const conflicts: SmoothStreamingConflict[] = []
    if (!db.useStreaming) {
        conflicts.push('responseStreamingOff')
    }
    // Balanced/Strong coalesce display updates into ~125ms batches, which defeats per-frame smoothing.
    if ((db.streamingDisplayOptimizationMode ?? 'off') !== 'off') {
        conflicts.push('streamingDisplayOptimizationOn')
    }
    return conflicts
}

export function isSmoothStreamingActive(db: Database): boolean {
    return !!db.smoothStreaming && getSmoothStreamingConflicts(db).length === 0
}

interface SmoothStreamOptions {
    /** Frames to catch up with the backlog while the source is still streaming. */
    catchUpFrames?: number
    /** Frames to drain the remaining backlog after the source has finished. */
    drainFrames?: number
}

function isHidden(): boolean {
    return typeof document !== 'undefined' && document.hidden
}

function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function' && !isHidden()) {
            requestAnimationFrame(() => resolve())
        } else {
            setTimeout(resolve, 16)
        }
    })
}

/**
 * Wraps a streaming response whose chunks carry the full accumulated text,
 * and re-emits that text growing a little every animation frame.
 *
 * Pull-based: a new frame is produced only after the consumer asks for it,
 * so slow post-processing makes each step larger instead of piling up work.
 */
export function smoothStream(
    source: ReadableStream<StreamChunk>,
    { catchUpFrames = 12, drainFrames = 4 }: SmoothStreamOptions = {}
): ReadableStream<StreamChunk> {
    const reader = source.getReader()
    let latest: StreamChunk = {}
    let key: string | null = null
    let shown = 0
    let done = false
    let failed = false
    let error: unknown = null
    let cancelled = false
    let wake: (() => void) | null = null

    const notify = () => {
        const w = wake
        wake = null
        w?.()
    }

    void (async () => {
        try {
            while (!cancelled) {
                const r = await reader.read()
                if (r.value) {
                    latest = r.value
                    key ??= Object.keys(r.value)[0] ?? null
                }
                if (r.done) break
                notify()
            }
        } catch (e) {
            failed = true
            error = e
        }
        done = true
        notify()
    })()

    return new ReadableStream<StreamChunk>({
        async pull(controller) {
            while (true) {
                if (failed) {
                    controller.error(error)
                    return
                }
                const full = key !== null ? (latest[key] ?? '') : ''
                // The source may rewrite earlier text (e.g. stripped tags); never show past the end.
                if (shown > full.length) shown = full.length
                const backlog = full.length - shown

                if (backlog > 0) {
                    await nextFrame()
                    if (cancelled) return
                    const current = key !== null ? (latest[key] ?? '') : ''
                    if (isHidden()) {
                        // Background tabs throttle timers; skip the animation entirely.
                        shown = current.length
                    } else {
                        const remaining = current.length - shown
                        const step = Math.ceil(remaining / (done ? drainFrames : catchUpFrames))
                        shown = Math.min(current.length, shown + Math.max(1, step))
                        // Don't split a UTF-16 surrogate pair (emoji etc.).
                        const code = current.charCodeAt(shown - 1)
                        if (shown < current.length && code >= 0xd800 && code <= 0xdbff) shown++
                    }
                    controller.enqueue({ ...latest, [key!]: current.slice(0, shown) })
                    return
                }

                if (done) {
                    // Final chunk with every key complete, so rerolls see the full text.
                    if (key !== null) controller.enqueue({ ...latest })
                    controller.close()
                    return
                }

                await new Promise<void>((resolve) => {
                    wake = resolve
                })
                if (cancelled) return
            }
        },
        cancel(reason) {
            cancelled = true
            notify()
            return reader.cancel(reason)
        },
    })
}
