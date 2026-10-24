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
    saveKeypairStore: vi.fn(),
    sleep: vi.fn(async () => {})
}))

import { sleep } from '../util'
import { NodeStorage } from './nodeStorage'

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

describe('NodeStorage rate limits', () => {
    const fetchMock = vi.fn()
    let storage:NodeStorage

    beforeEach(() => {
        fetchMock.mockReset()
        vi.mocked(sleep).mockClear()
        vi.stubGlobal('fetch', fetchMock)
        storage = new NodeStorage()
        vi.spyOn(storage as any, 'checkAuth').mockResolvedValue(undefined)
        vi.spyOn(storage, 'createAuth').mockResolvedValue('test-auth')
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    function limited(retryAfter?:string) {
        return new Response(JSON.stringify({ error: 'Too many requests. Please retry shortly.' }), {
            status: 429,
            headers: retryAfter ? { 'Retry-After': retryAfter } : {}
        })
    }

    it('waits for Retry-After and reads again', async () => {
        fetchMock
            .mockResolvedValueOnce(limited('12'))
            .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])))

        expect([...await storage.getItem('assets/a.png')]).toEqual([1, 2, 3])
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(sleep).toHaveBeenCalledWith(12000)
        expect(storage.createAuth).toHaveBeenCalledTimes(2)
    })

    it('writes again after being rate limited', async () => {
        fetchMock
            .mockResolvedValueOnce(limited())
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })))

        await storage.setItem('assets/a.png', new Uint8Array(3))
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(sleep).toHaveBeenCalledWith(5000)
    })

    it('gives up after a few rate limited attempts', async () => {
        fetchMock.mockImplementation(async () => limited('1'))

        await expect(storage.setItem('assets/a.png', new Uint8Array(3))).rejects.toThrow('HTTP: 429')
        expect(fetchMock).toHaveBeenCalledTimes(4)
    })
})

describe('NodeStorage.readBatch', () => {
    const fetchMock = vi.fn()
    let storage:NodeStorage

    beforeEach(() => {
        fetchMock.mockReset()
        vi.mocked(sleep).mockClear()
        vi.stubGlobal('fetch', fetchMock)
        storage = new NodeStorage()
        vi.spyOn(storage as any, 'checkAuth').mockResolvedValue(undefined)
        vi.spyOn(storage, 'createAuth').mockResolvedValue('test-auth')
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.restoreAllMocks()
    })

    function item(status:number, data:number[] = []) {
        const header = new Uint8Array(5)
        header[0] = status
        new DataView(header.buffer).setUint32(1, data.length, true)
        return [...header, ...data]
    }

    it('sends hex paths and splits the response per key', async () => {
        fetchMock.mockResolvedValue(new Response(new Uint8Array([
            ...item(1, [1, 2, 3]),
            ...item(0),
            ...item(1),
            ...item(2),
        ])))

        const results = await storage.readBatch(['assets/a.png', 'assets/b.png', 'assets/c.png', 'assets/d.png'])
        expect(results.map((result) => result && [...result])).toEqual([[1, 2, 3], null, null, undefined])
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe('/api/read_batch')
        expect(init.method).toBe('POST')
        expect(init.headers['risu-auth']).toBe('test-auth')
        expect(JSON.parse(init.body).paths).toEqual([
            Buffer.from('assets/a.png').toString('hex'),
            Buffer.from('assets/b.png').toString('hex'),
            Buffer.from('assets/c.png').toString('hex'),
            Buffer.from('assets/d.png').toString('hex'),
        ])
    })

    it('rejects a response that ends early or runs long', async () => {
        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([...item(1, [1, 2, 3])].slice(0, 6))))
        await expect(storage.readBatch(['a'])).rejects.toThrow('ended early')

        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([...item(1, [1]), ...item(0)])))
        await expect(storage.readBatch(['a'])).rejects.toThrow('longer than expected')
    })

    it('waits out rate limits', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '3' } }))
            .mockResolvedValueOnce(new Response(new Uint8Array(item(1, [7]))))

        expect((await storage.readBatch(['a'])).map((result) => result && [...result])).toEqual([[7]])
        expect(sleep).toHaveBeenCalledWith(3000)
        expect(storage.createAuth).toHaveBeenCalledTimes(2)
    })

    it('stops asking servers without the batch route', async () => {
        fetchMock.mockResolvedValue(new Response('Cannot POST /api/read_batch', { status: 404 }))

        expect(await storage.readBatch(['a', 'b'])).toEqual([undefined, undefined])
        expect(await storage.readBatch(['c'])).toEqual([undefined])
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(storage.batchUnsupported).toBe(true)
    })

    it('takes at most 100 keys', async () => {
        await expect(storage.readBatch(Array.from({ length: 101 }, (_, i) => `k${i}`))).rejects.toThrow('1 to 100')
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
