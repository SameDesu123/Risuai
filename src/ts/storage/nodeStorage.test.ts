import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({
    language: {}
}))

vi.mock('../alert', () => ({
    alertError: vi.fn(),
    alertInput: vi.fn(),
    waitAlert: vi.fn()
}))

vi.mock('../util', () => ({
    base64url: vi.fn(),
    getKeypairStore: vi.fn(),
    saveKeypairStore: vi.fn()
}))

import { NODE_READ_BULK_MAX_ITEMS, NodeStorage, parseReadBulkStream } from './nodeStorage'

describe('NodeStorage.setItem', () => {
    const fetchMock = vi.fn()
    let storage:NodeStorage

    beforeEach(() => {
        fetchMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
        storage = new NodeStorage()
        vi.spyOn(storage as any, 'checkAuth').mockResolvedValue(undefined)
        vi.spyOn(storage, 'createAuth').mockResolvedValue('test-auth')
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it('includes storage context and JSON server details for HTTP errors', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            error: 'Failed to write storage item',
            code: 'ENOSPC',
            message: "ENOSPC: no space left on device, open './save/64617461626173652f64617461626173652e62696e'"
        }), {
            status: 507,
            statusText: 'Insufficient Storage',
            headers: {
                'content-type': 'application/json'
            }
        }))

        await expect(storage.setItem('database/database.bin', new Uint8Array(2048))).rejects.toThrow(
            'Node storage setItem failed.\n' +
            'Key: database/database.bin\n' +
            'Size: 2048 bytes (2.00 KiB)\n' +
            'HTTP: 507 Insufficient Storage\n' +
            'Server: Failed to write storage item | ENOSPC | ' +
            "ENOSPC: no space left on device, open './save/64617461626173652f64617461626173652e62696e'"
        )
    })

    it('includes structured server details for payload limit errors', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            error: 'Storage payload is too large',
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Storage writes are limited to 100 MiB.'
        }), {
            status: 413,
            statusText: 'Payload Too Large',
            headers: {
                'content-type': 'application/json'
            }
        }))

        await expect(storage.setItem('assets/example', new Uint8Array(3))).rejects.toThrow(
            'HTTP: 413 Payload Too Large\n' +
            'Server: Storage payload is too large | PAYLOAD_TOO_LARGE | Storage writes are limited to 100 MiB.'
        )
    })

    it('extracts useful text from an HTML error response', async () => {
        fetchMock.mockResolvedValue(new Response(
            '<!DOCTYPE html><html><body><pre>PayloadTooLargeError: request entity too large<br>at parser</pre></body></html>',
            {
                status: 413,
                statusText: 'Payload Too Large',
                headers: {
                    'content-type': 'text/html'
                }
            }
        ))

        await expect(storage.setItem('assets/example', new Uint8Array(3))).rejects.toThrow(
            'HTTP: 413 Payload Too Large\nServer: PayloadTooLargeError: request entity too large\nat parser'
        )
    })

    it('distinguishes network failures from HTTP failures', async () => {
        fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

        await expect(storage.setItem('database/database.bin', new Uint8Array(3))).rejects.toThrow(
            'Node storage setItem request failed.\n' +
            'Key: database/database.bin\n' +
            'Size: 3 bytes\n' +
            'Cause: Failed to fetch'
        )
    })
})

function frame(item:Uint8Array|null) {
    if(item === null){
        return new Uint8Array([0])
    }
    const out = new Uint8Array(5 + item.byteLength)
    out[0] = 1
    new DataView(out.buffer).setUint32(1, item.byteLength)
    out.set(item, 5)
    return out
}

function concat(chunks:Uint8Array[]) {
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    let offset = 0
    for(const chunk of chunks){
        out.set(chunk, offset)
        offset += chunk.byteLength
    }
    return out
}

/** Builds a stream that emits data split into chunks of the given size */
function streamOf(data:Uint8Array, chunkSize = data.byteLength || 1) {
    let offset = 0
    const pulled = { count: 0, cancelled: false }
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if(offset >= data.byteLength){
                controller.close()
                return
            }
            pulled.count += 1
            controller.enqueue(data.slice(offset, offset + chunkSize))
            offset += chunkSize
        },
        cancel() {
            pulled.cancelled = true
        }
    }, { highWaterMark: 0 })
    return { stream, pulled }
}

async function collect(stream:ReadableStream<Uint8Array>|null, keys:string[]) {
    const out:(number[]|null)[] = []
    for await (const { data } of parseReadBulkStream(stream, keys)){
        out.push(data === null ? null : Array.from(data))
    }
    return out
}

describe('parseReadBulkStream', () => {
    const items = [
        new TextEncoder().encode('hello'),
        null,
        new Uint8Array(0),
        new Uint8Array([1, 2, 3])
    ]
    const keys = ['a', 'b', 'c', 'd']
    const expected = [Array.from(new TextEncoder().encode('hello')), null, null, [1, 2, 3]]

    it.each([1, 2, 3, 7, 1024])('yields items in order with null for missing and empty items (chunk size %i)', async (chunkSize) => {
        const { stream } = streamOf(concat(items.map(frame)), chunkSize)
        await expect(collect(stream, keys)).resolves.toEqual(expected)
    })

    it('yields keys with each item', async () => {
        const { stream } = streamOf(concat(items.map(frame)))
        const yieldedKeys:string[] = []
        for await (const { key } of parseReadBulkStream(stream, keys)){
            yieldedKeys.push(key)
        }
        expect(yieldedKeys).toEqual(keys)
    })

    it('rejects truncated and invalid responses', async () => {
        const full = frame(new Uint8Array([1, 2, 3]))
        await expect(collect(streamOf(full.subarray(0, 6)).stream, ['a'])).rejects.toThrow('truncated')
        await expect(collect(streamOf(full).stream, ['a', 'b'])).rejects.toThrow('truncated')
        await expect(collect(streamOf(concat([full, frame(null)])).stream, ['a'])).rejects.toThrow('invalid')
        await expect(collect(streamOf(new Uint8Array([2])).stream, ['a'])).rejects.toThrow('invalid')
        await expect(collect(null, ['a'])).rejects.toThrow('truncated')
    })

    it('reads lazily and cancels the stream when the consumer stops early', async () => {
        const big = new Uint8Array(64).fill(9)
        const { stream, pulled } = streamOf(concat([frame(big), frame(big), frame(big)]), 16)
        for await (const { data } of parseReadBulkStream(stream, ['a', 'b', 'c'])){
            expect(data?.byteLength).toBe(64)
            break
        }
        // Only the first frame (69 bytes) should have been pulled before stopping
        expect(pulled.count).toBeLessThanOrEqual(5)
        expect(pulled.cancelled).toBe(true)
    })
})

describe('NodeStorage.getItems', () => {
    const fetchMock = vi.fn()
    let storage:NodeStorage

    beforeEach(() => {
        fetchMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
        storage = new NodeStorage()
        vi.spyOn(storage as any, 'checkAuth').mockResolvedValue(undefined)
        vi.spyOn(storage, 'createAuth').mockResolvedValue('test-auth')
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    it(`splits requests into chunks of ${NODE_READ_BULK_MAX_ITEMS} hex paths`, async () => {
        const keys = Array.from({ length: NODE_READ_BULK_MAX_ITEMS + 5 }, (_, i) => `assets/${i}`)
        fetchMock.mockImplementation(async (_url:string, init:RequestInit) => {
            const { paths } = JSON.parse(init.body as string) as { paths:string[] }
            const frames = paths.map((hex) => {
                const key = Buffer.from(hex, 'hex').toString('utf-8')
                return key === 'assets/3' ? frame(null) : frame(new TextEncoder().encode(key))
            })
            return new Response(concat(frames), { status: 200 })
        })

        const result = await storage.getItems(keys)

        expect(fetchMock).toHaveBeenCalledTimes(2)
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('/api/read_bulk')
        expect(init.method).toBe('POST')
        expect(init.headers['risu-auth']).toBe('test-auth')
        expect(JSON.parse(init.body).paths).toHaveLength(NODE_READ_BULK_MAX_ITEMS)
        expect(JSON.parse(init.body).paths[0]).toBe(Buffer.from('assets/0', 'utf-8').toString('hex'))
        expect(JSON.parse(fetchMock.mock.calls[1][1].body).paths).toHaveLength(5)
        expect(result).toHaveLength(keys.length)
        expect(result[3]).toBeNull()
        expect(result.map((item, i) => i === 3 ? null : item.toString('utf-8'))).toEqual(
            keys.map((key, i) => i === 3 ? null : key)
        )
    })

    it('does not send a request for an empty key list', async () => {
        await expect(storage.getItems([])).resolves.toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('includes server details for HTTP errors', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            error: 'Too many file paths. Up to 100 paths can be read at once.'
        }), { status: 400, headers: { 'content-type': 'application/json' } }))

        await expect(storage.getItems(['a'])).rejects.toThrow(
            'Node storage read_bulk failed.\nHTTP: 400\nServer: Too many file paths. Up to 100 paths can be read at once.'
        )
    })
})
