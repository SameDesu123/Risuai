import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    decodeProxyJobWsChunk,
    formatProxyStreamErrorMessage,
    parseProxyJobWsEvent,
    startProxyJobWsRelay,
    type ProxyJobWsRelayOptions,
    type ProxyJobWsSocket
} from './proxyJobWs'

describe('parseProxyJobWsEvent', () => {
    it('parses valid proxy job events', () => {
        const event = parseProxyJobWsEvent(JSON.stringify({
            type: 'chunk',
            dataBase64: Buffer.from('hello', 'utf-8').toString('base64')
        }))
        expect(event).not.toBeNull()
        expect(event?.type).toBe('chunk')
    })

    it('returns null for invalid input', () => {
        expect(parseProxyJobWsEvent('not-json')).toBeNull()
        expect(parseProxyJobWsEvent(JSON.stringify({ nope: 1 }))).toBeNull()
    })
})

describe('decodeProxyJobWsChunk', () => {
    it('decodes base64 payload into bytes', () => {
        const bytes = decodeProxyJobWsChunk(Buffer.from('abc', 'utf-8').toString('base64'))
        expect(new TextDecoder().decode(bytes)).toBe('abc')
    })
})

describe('formatProxyStreamErrorMessage', () => {
    it('maps cloudflare/origin timeout errors to clear message', () => {
        const msg = formatProxyStreamErrorMessage(504, '<!DOCTYPE html><title>Gateway time-out</title>')
        expect(msg).toContain('Cloudflare/origin timeout')
    })

    it('keeps the relay\'s own 504 messages', () => {
        expect(formatProxyStreamErrorMessage(504, 'No data received from upstream for 3000ms')).toBe('No data received from upstream for 3000ms')
    })

    it('passes through non-timeout messages', () => {
        expect(formatProxyStreamErrorMessage(400, 'bad request')).toBe('bad request')
    })
})

class FakeSocket implements ProxyJobWsSocket {
    static instances: FakeSocket[] = []
    onopen: ((event: unknown) => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    onclose: ((event: unknown) => void) | null = null
    closed = false

    constructor(public url: string) {
        FakeSocket.instances.push(this)
    }

    close() {
        this.closed = true
    }

    send(event: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(event) })
    }

    drop() {
        this.onclose?.({})
    }
}

const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64')
const latestSocket = () => FakeSocket.instances[FakeSocket.instances.length - 1]

function makeFetch() {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'POST' && url.endsWith('/proxy-stream-jobs')) {
            return new Response(JSON.stringify({ jobId: 'job-1', heartbeatSec: 5 }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 })
    })
}

function deleteCalls(fetchMock: ReturnType<typeof makeFetch>) {
    return fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')
}

async function readAll(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) {
            return text + decoder.decode()
        }
        text += decoder.decode(value, { stream: true })
    }
}

/** Starts a relay and feeds it headers on the first socket, as a new server would. */
async function startWithHeaders(extra: Partial<ProxyJobWsRelayOptions> = {}) {
    const fetchMock = makeFetch()
    const pending = startProxyJobWsRelay({
        baseUrl: '',
        wsOrigin: 'ws://relay.test',
        auth: 'token',
        url: 'http://192.168.0.2:8080/v1/chat/completions',
        method: 'POST',
        body: new TextEncoder().encode('{}'),
        heartbeatSec: 5,
        reconnect: { initialDelayMs: 500, maxDelayMs: 4000, budgetMs: 30000 },
        ...extra
    }, {
        fetch: fetchMock as unknown as typeof fetch,
        WebSocket: FakeSocket
    })
    await vi.advanceTimersByTimeAsync(0)
    const first = latestSocket()
    first.send({ type: 'job_accepted', jobId: 'job-1', resumable: true })
    first.send({ type: 'upstream_headers', status: 200, headers: { 'content-type': 'text/event-stream' }, seq: 1 })
    const result = await pending
    return { fetchMock, result, first }
}

describe('startProxyJobWsRelay', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        FakeSocket.instances = []
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('reconnects with after=lastSeq and continues without duplicates or gaps', async () => {
        const { result, first } = await startWithHeaders()
        expect(first.url).toContain('after=0')
        expect(result.status).toBe(200)

        const reading = readAll(result.body)
        first.send({ type: 'chunk', dataBase64: b64('ab'), seq: 2 })
        first.drop()

        await vi.advanceTimersByTimeAsync(500)
        const second = latestSocket()
        expect(second).not.toBe(first)
        expect(second.url).toContain('after=2')

        second.send({ type: 'job_accepted', jobId: 'job-1', resumable: true })
        second.send({ type: 'chunk', dataBase64: b64('ab'), seq: 2 })
        second.send({ type: 'chunk', dataBase64: b64('cd'), seq: 3 })
        second.send({ type: 'done', seq: 4 })

        await expect(reading).resolves.toBe('abcd')
    })

    it('reconnects when the socket drops before the headers arrive', async () => {
        const fetchMock = makeFetch()
        const pending = startProxyJobWsRelay({
            baseUrl: '',
            wsOrigin: 'ws://relay.test',
            auth: 'token',
            url: 'http://192.168.0.2:8080/v1/chat/completions',
            method: 'POST',
            heartbeatSec: 5
        }, {
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: FakeSocket
        })
        await vi.advanceTimersByTimeAsync(0)
        latestSocket().drop()
        await vi.advanceTimersByTimeAsync(500)
        const second = latestSocket()
        expect(FakeSocket.instances).toHaveLength(2)
        second.send({ type: 'job_accepted', jobId: 'job-1', resumable: true })
        second.send({ type: 'upstream_headers', status: 200, headers: { 'content-type': 'text/event-stream' }, seq: 1 })
        second.send({ type: 'chunk', dataBase64: b64('ok'), seq: 2 })
        second.send({ type: 'done', seq: 3 })
        const result = await pending
        await expect(readAll(result.body)).resolves.toBe('ok')
    })

    it('ends the stream with an error when reconnecting runs out', async () => {
        const { result, first } = await startWithHeaders({
            reconnect: { initialDelayMs: 100, maxDelayMs: 400, budgetMs: 2000 }
        })
        const reading = readAll(result.body)
        const settledReading = reading.catch((error) => error)
        first.drop()
        for (let i = 0; i < 20; i++) {
            await vi.advanceTimersByTimeAsync(400)
            latestSocket().drop()
        }
        const error = await settledReading
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('could not be resumed')
    })

    it('ends the stream with an error on replay_gap', async () => {
        const { result, first } = await startWithHeaders()
        const reading = readAll(result.body).catch((error) => error)
        first.send({ type: 'chunk', dataBase64: b64('ab'), seq: 2 })
        first.drop()
        await vi.advanceTimersByTimeAsync(500)
        latestSocket().send({ type: 'error', code: 'replay_gap', status: 502, message: 'gap' })
        const error = await reading
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toBe('gap')
    })

    it('sends DELETE when aborted after the headers', async () => {
        const controller = new AbortController()
        const { result, fetchMock } = await startWithHeaders({ signal: controller.signal })
        const reading = readAll(result.body).catch((error) => error)
        expect(deleteCalls(fetchMock)).toHaveLength(0)
        controller.abort()
        const error = await reading
        expect((error as Error).name).toBe('AbortError')
        expect(deleteCalls(fetchMock)).toHaveLength(1)
        expect(String(deleteCalls(fetchMock)[0][0])).toBe('/proxy-stream-jobs/job-1')
    })

    it('sends DELETE when the body is cancelled', async () => {
        const { result, fetchMock, first } = await startWithHeaders()
        await result.body.cancel()
        expect(deleteCalls(fetchMock)).toHaveLength(1)
        expect(first.closed).toBe(true)
    })

    it('treats a drop as fatal when the server sends no seq', async () => {
        const fetchMock = makeFetch()
        const pending = startProxyJobWsRelay({
            baseUrl: '',
            wsOrigin: 'ws://relay.test',
            auth: 'token',
            url: 'http://192.168.0.2:8080/v1/chat/completions',
            method: 'POST',
            heartbeatSec: 5
        }, {
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: FakeSocket
        })
        await vi.advanceTimersByTimeAsync(0)
        const first = latestSocket()
        first.send({ type: 'job_accepted', jobId: 'job-1' })
        first.send({ type: 'upstream_headers', status: 200, headers: { 'content-type': 'text/event-stream' } })
        const result = await pending
        const reading = readAll(result.body).catch((error) => error)
        first.send({ type: 'chunk', dataBase64: b64('ab') })
        first.drop()
        const error = await reading
        expect(error).toBeInstanceOf(Error)
        await vi.advanceTimersByTimeAsync(5000)
        expect(FakeSocket.instances).toHaveLength(1)
    })

    it('closes a silent socket after heartbeat x3 and reconnects', async () => {
        const { result, first } = await startWithHeaders()
        void readAll(result.body).catch(() => {})
        await vi.advanceTimersByTimeAsync(14_000)
        expect(first.closed).toBe(false)
        first.send({ type: 'ping', ts: 1 })
        await vi.advanceTimersByTimeAsync(14_000)
        expect(first.closed).toBe(false)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(first.closed).toBe(true)
        await vi.advanceTimersByTimeAsync(500)
        expect(FakeSocket.instances).toHaveLength(2)
        expect(latestSocket().url).toContain('after=1')
    })

    it('returns an error response when the server fails before the headers', async () => {
        const fetchMock = makeFetch()
        const pending = startProxyJobWsRelay({
            baseUrl: '',
            wsOrigin: 'ws://relay.test',
            auth: 'token',
            url: 'http://192.168.0.2:8080/v1/chat/completions',
            method: 'POST',
            heartbeatSec: 5
        }, {
            fetch: fetchMock as unknown as typeof fetch,
            WebSocket: FakeSocket
        })
        await vi.advanceTimersByTimeAsync(0)
        latestSocket().send({ type: 'error', status: 400, message: 'Blocked non-local target URL', seq: 1 })
        const result = await pending
        expect(result.status).toBe(400)
        await expect(readAll(result.body)).resolves.toBe('Blocked non-local target URL')
    })
})
