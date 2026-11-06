import { describe, expect, it, vi } from 'vitest'

import { createChunkQueueStream } from './chunkQueueStream'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('createChunkQueueStream', () => {
    it('merges chunks queued between reads into one', async () => {
        const queue = createChunkQueueStream()
        const reader = queue.stream.getReader()

        queue.push(encoder.encode('a'))
        queue.push(encoder.encode('b'))
        queue.push(encoder.encode('c'))
        const first = await reader.read()
        expect(decoder.decode(first.value)).toBe('abc')

        queue.push(encoder.encode('d'))
        const second = await reader.read()
        expect(decoder.decode(second.value)).toBe('d')
    })

    it('waits for data when nothing is queued', async () => {
        const queue = createChunkQueueStream()
        const reader = queue.stream.getReader()

        const pending = reader.read()
        queue.push(encoder.encode('late'))

        const result = await pending
        expect(decoder.decode(result.value)).toBe('late')
    })

    it('delivers queued bytes before ending on close', async () => {
        const queue = createChunkQueueStream()
        const reader = queue.stream.getReader()

        queue.push(encoder.encode('rest'))
        queue.close()
        queue.push(encoder.encode('ignored'))

        const result = await reader.read()
        expect(decoder.decode(result.value)).toBe('rest')
        await expect(reader.read()).resolves.toMatchObject({ done: true })
    })

    it('ends a pending read on close', async () => {
        const queue = createChunkQueueStream()
        const reader = queue.stream.getReader()

        const pending = reader.read()
        queue.close()

        await expect(pending).resolves.toMatchObject({ done: true })
    })

    it('reports cancellation and ignores later chunks', async () => {
        const onCancel = vi.fn()
        const queue = createChunkQueueStream(onCancel)
        const reader = queue.stream.getReader()

        const pending = reader.read()
        await reader.cancel('stopped')
        queue.push(encoder.encode('after cancel'))

        await expect(pending).resolves.toMatchObject({ done: true })
        expect(onCancel).toHaveBeenCalledOnce()
        expect(onCancel).toHaveBeenCalledWith('stopped')
    })
})
