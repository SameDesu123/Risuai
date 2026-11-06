export interface ChunkQueueStream {
    stream: ReadableStream<Uint8Array>
    /** Queues bytes for the reader. Ignored after close() or once the reader cancels. */
    push(chunk: Uint8Array): void
    /** Ends the stream after the bytes queued so far have been read. */
    close(): void
}

/**
 * A byte stream fed from outside, such as by a Tauri channel. Each read takes
 * every byte queued since the previous read as one chunk, so a reader that falls
 * behind catches up in one step instead of working through the backlog piece by
 * piece. With highWaterMark 0 nothing leaves the queue until someone reads, so
 * bytes that arrive while the reader is busy are merged instead of buffered
 * one by one.
 */
export function createChunkQueueStream(onCancel?: (reason: unknown) => void): ChunkQueueStream {
    let queued: Uint8Array[] = []
    let queuedBytes = 0
    let closed = false
    let cancelled = false
    let wake: (() => void) | null = null

    const notify = () => {
        const resolve = wake
        wake = null
        resolve?.()
    }

    const takeQueued = () => {
        let chunk: Uint8Array = queued[0]
        if (queued.length > 1) {
            chunk = new Uint8Array(queuedBytes)
            let offset = 0
            for (const part of queued) {
                chunk.set(part, offset)
                offset += part.byteLength
            }
        }
        queued = []
        queuedBytes = 0
        return chunk
    }

    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            while (queued.length === 0 && !closed && !cancelled) {
                await new Promise<void>((resolve) => {
                    wake = resolve
                })
            }
            if (cancelled) {
                return
            }
            if (queued.length > 0) {
                controller.enqueue(takeQueued())
                return
            }
            controller.close()
        },
        cancel(reason) {
            cancelled = true
            queued = []
            queuedBytes = 0
            notify()
            onCancel?.(reason)
        },
    }, { highWaterMark: 0 })

    return {
        stream,
        push(chunk) {
            if (closed || cancelled || chunk.byteLength === 0) {
                return
            }
            queued.push(chunk)
            queuedBytes += chunk.byteLength
            notify()
        },
        close() {
            closed = true
            notify()
        },
    }
}
