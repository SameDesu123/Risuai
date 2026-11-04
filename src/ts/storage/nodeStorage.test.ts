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

import { NODE_READ_BULK_MAX_ITEMS, NodeStorage, parseReadBulkResponse } from './nodeStorage'

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

describe('parseReadBulkResponse', () => {
    it('returns items in order with null for missing and empty items', () => {
        const data = concat([
            frame(new TextEncoder().encode('hello')),
            frame(null),
            frame(new Uint8Array(0)),
            frame(new Uint8Array([1, 2, 3]))
        ])
        const result = parseReadBulkResponse(data, 4)
        expect(result.map((item) => item === null ? null : Array.from(item))).toEqual([
            Array.from(new TextEncoder().encode('hello')),
            null,
            null,
            [1, 2, 3]
        ])
    })

    it('rejects truncated and oversized responses', () => {
        const full = frame(new Uint8Array([1, 2, 3]))
        expect(() => parseReadBulkResponse(full.subarray(0, 6), 1)).toThrow('truncated')
        expect(() => parseReadBulkResponse(full, 2)).toThrow('truncated')
        expect(() => parseReadBulkResponse(concat([full, frame(null)]), 1)).toThrow('invalid')
        expect(() => parseReadBulkResponse(new Uint8Array([2]), 1)).toThrow('invalid')
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
            'Node storage getItems failed.\nHTTP: 400\nServer: Too many file paths. Up to 100 paths can be read at once.'
        )
    })
})
