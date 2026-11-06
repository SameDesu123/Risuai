import { describe, expect, it, vi } from 'vitest'

import { createChunkQueueStream } from './chunkQueueStream'
import { pipeStreamWithTextLog } from './streamFetchLog'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('pipeStreamWithTextLog', () => {
    it('forwards the complete stream and records its text', async () => {
        const onFinalize = vi.fn()
        const source = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('hel'))
                controller.enqueue(encoder.encode('lo'))
                controller.close()
            },
        })

        const response = new Response(pipeStreamWithTextLog(source, onFinalize))

        await expect(response.text()).resolves.toBe('hello')
        expect(onFinalize).toHaveBeenCalledOnce()
        expect(onFinalize).toHaveBeenCalledWith('hello')
    })

    it('keeps multibyte characters split across chunks intact', async () => {
        const onFinalize = vi.fn()
        const bytes = encoder.encode('가나')
        const source = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes.slice(0, 2))
                controller.enqueue(bytes.slice(2))
                controller.close()
            },
        })

        await new Response(pipeStreamWithTextLog(source, onFinalize)).arrayBuffer()

        expect(onFinalize).toHaveBeenCalledWith('가나')
    })

    it('propagates cancellation and records only consumed data', async () => {
        const onCancel = vi.fn()
        const onFinalize = vi.fn()
        const source = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('first'))
            },
            cancel: onCancel,
        })
        const reader = pipeStreamWithTextLog(source, onFinalize).getReader()

        await expect(reader.read()).resolves.toMatchObject({ done: false })
        await reader.cancel('stopped')

        expect(onCancel).toHaveBeenCalledWith('stopped')
        expect(onFinalize).toHaveBeenCalledOnce()
        expect(onFinalize).toHaveBeenCalledWith('first')
    })

    it('does not read ahead, so chunk merging still reaches the consumer', async () => {
        const queue = createChunkQueueStream()
        const reader = pipeStreamWithTextLog(queue.stream, () => {}).getReader()

        const first = reader.read()
        queue.push(encoder.encode('a'))
        expect(decoder.decode((await first).value)).toBe('a')

        queue.push(encoder.encode('b'))
        queue.push(encoder.encode('c'))
        expect(decoder.decode((await reader.read()).value)).toBe('bc')
    })
})
