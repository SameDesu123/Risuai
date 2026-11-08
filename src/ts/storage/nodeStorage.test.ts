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

describe('NodeStorage.saveDatabase', () => {
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

    function jsonResponse(body:unknown, status:number) {
        return new Response(JSON.stringify(body), {
            status,
            headers: {
                'content-type': 'application/json'
            }
        })
    }

    it('posts the payload and returns the new revision', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, revision: 'rev-1' }, 200))

        await expect(storage.saveDatabase(new Uint8Array([1, 2, 3]))).resolves.toEqual({ status: 'saved', revision: 'rev-1' })
        expect(fetchMock).toHaveBeenCalledWith('/api/db/save', expect.objectContaining({
            method: 'POST',
            headers: {
                'content-type': 'application/octet-stream',
                'risu-auth': 'test-auth'
            }
        }))
    })

    it('reports a server without /api/db/save as unsupported', async () => {
        fetchMock.mockResolvedValue(new Response('Cannot POST /api/db/save', { status: 404 }))

        await expect(storage.saveDatabase(new Uint8Array(3))).resolves.toEqual({ status: 'unsupported' })
    })

    it('reports an out-of-date base revision as stale', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: 'changed', code: 'DB_SAVE_STALE' }, 409))

        await expect(storage.saveDatabase(new Uint8Array(3))).resolves.toEqual({ status: 'stale' })
    })

    it('throws with server details for other failures', async () => {
        fetchMock.mockResolvedValue(jsonResponse({ error: 'Failed to save the database', code: 'ENOSPC' }, 507))

        await expect(storage.saveDatabase(new Uint8Array(3))).rejects.toThrow(
            'Node storage database save failed.\n' +
            'Key: database/database.bin (server save)\n' +
            'Size: 3 bytes\n' +
            'HTTP: 507\n' +
            'Server: Failed to save the database | ENOSPC'
        )
    })
})
