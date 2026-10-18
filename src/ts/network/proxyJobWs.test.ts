import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    decodeProxyJobWsChunk,
    formatProxyStreamErrorMessage,
    openProxyJobStream,
    parseProxyJobWsEvent,
    ProxyJobCreateUncertainError,
    type ProxyJobSocket,
    type ProxyJobStreamOptions,
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

    it('passes through non-timeout messages', () => {
        expect(formatProxyStreamErrorMessage(400, 'bad request')).toBe('bad request')
    })
})

const jobId = '00000000-0000-4000-8000-000000000001'

class FakeSocket implements ProxyJobSocket {
    onmessage: ProxyJobSocket['onmessage'] = null
    onclose: ProxyJobSocket['onclose'] = null
    onerror: ProxyJobSocket['onerror'] = null
    closed = false

    constructor(readonly url: string) {}

    emit(event: Record<string, unknown>) {
        this.onmessage?.({ data: JSON.stringify(event) })
    }

    drop() {
        this.onerror?.(new Event('error'))
        this.onclose?.(new Event('close'))
    }

    close() {
        this.closed = true
    }
}

function reply(status: number, body: unknown = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response
}

const headers = (seq: number) => ({ type: 'upstream_headers', seq, status: 200, headers: { 'content-type': 'text/event-stream' } })
const chunk = (seq: number, text: string) => ({ type: 'chunk', seq, dataBase64: Buffer.from(text).toString('base64') })
const done = (seq: number) => ({ type: 'done', seq })

type Handler = (url: string) => Response | Promise<Response>

function setup(handlers: { create?: Handler[], snapshot?: Handler[], onSocket?: (socket: FakeSocket) => void } = {}) {
    const sockets: FakeSocket[] = []
    const requests: { method: string, url: string, body?: Record<string, unknown> }[] = []
    const createHandlers = [...(handlers.create ?? [])]
    const snapshotHandlers = [...(handlers.snapshot ?? [])]
    let wake = () => {}
    const fetch = async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        requests.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined })
        if (method === 'POST') {
            return (createHandlers.shift() ?? (() => reply(200, { jobId, heartbeatSec: 10 })))(url)
        }
        if (method === 'DELETE') {
            return reply(200, { success: true })
        }
        return (snapshotHandlers.shift() ?? (() => reply(404)))(url)
    }
    const deps = {
        fetch,
        createWebSocket: (url: string) => {
            const socket = new FakeSocket(url)
            sockets.push(socket)
            handlers.onSocket?.(socket)
            return socket
        },
        createJobId: () => jobId,
        onWake: (callback: () => void) => {
            wake = callback
            return () => {
                wake = () => {}
            }
        },
    }
    return {
        sockets,
        requests,
        deps,
        wake: () => wake(),
        deletes: () => requests.filter((request) => request.method === 'DELETE'),
    }
}

function streamOptions(extra: Partial<ProxyJobStreamOptions> = {}): ProxyJobStreamOptions {
    return {
        baseUrl: '',
        wsBaseUrl: 'wss://risu.test',
        auth: 'pw',
        request: {
            url: 'http://127.0.0.1:8080/v1/chat/completions',
            method: 'POST',
            headers: {},
            bodyBase64: '',
            heartbeatSec: 10,
        },
        ...extra,
    }
}

async function readText(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
        const { done, value } = await reader.read()
        if (done) {
            return text
        }
        text += decoder.decode(value, { stream: true })
    }
}

async function startStream(env: ReturnType<typeof setup>, extra: Partial<ProxyJobStreamOptions> = {}) {
    const pending = openProxyJobStream(streamOptions(extra), env.deps)
    await vi.advanceTimersByTimeAsync(0)
    env.sockets[0].emit({ type: 'job_accepted', jobId })
    env.sockets[0].emit(headers(1))
    const res = await pending
    return { res, text: readText(res.body) }
}

describe('openProxyJobStream', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('streams a job and frees its stored result once done', async () => {
        const env = setup()
        const { res, text } = await startStream(env)
        expect(env.requests[0].body?.jobId).toBe(jobId)
        expect(env.sockets[0].url).toBe(`wss://risu.test/proxy-stream-jobs/${jobId}/ws?risu-auth=pw&since=0`)

        env.sockets[0].emit(chunk(2, 'Hel'))
        env.sockets[0].emit(chunk(3, 'lo'))
        env.sockets[0].emit(done(4))

        expect(res.status).toBe(200)
        expect(await text).toBe('Hello')
        expect(env.deletes()).toHaveLength(1)
        expect(env.sockets[0].closed).toBe(true)
    })

    it('resumes after the last seq it saw when the connection drops', async () => {
        const env = setup({
            snapshot: [(url) => {
                expect(url).toBe(`/proxy-stream-jobs/${jobId}?since=2`)
                return reply(200, { done: false, lastSeq: 3, events: [chunk(3, 'lo')] })
            }],
        })
        const { text } = await startStream(env)
        env.sockets[0].emit(chunk(2, 'Hel'))
        env.sockets[0].drop()

        await vi.advanceTimersByTimeAsync(500)
        expect(env.sockets).toHaveLength(2)
        expect(env.sockets[1].url).toContain('since=3')
        // The server replays from `since`, which may repeat what the snapshot already had
        env.sockets[1].emit(chunk(3, 'lo'))
        env.sockets[1].emit(chunk(4, '!'))
        env.sockets[1].emit(done(5))

        expect(await text).toBe('Hello!')
    })

    it('finishes from the snapshot when the job ended while disconnected', async () => {
        const env = setup({
            snapshot: [() => reply(200, { done: true, lastSeq: 3, events: [chunk(2, 'Hi'), done(3)] })],
        })
        const { text } = await startStream(env)
        env.sockets[0].drop()

        await vi.advanceTimersByTimeAsync(500)
        expect(await text).toBe('Hi')
        expect(env.sockets).toHaveLength(1)
    })

    it('errors the body when the job is gone from the server', async () => {
        const env = setup({ snapshot: [() => reply(404)] })
        const { text } = await startStream(env)
        env.sockets[0].emit(chunk(2, 'Hel'))
        env.sockets[0].drop()

        const result = text.catch((error: Error) => error)
        await vi.advanceTimersByTimeAsync(500)
        expect(String(await result)).toContain('no longer exists on the server')
    })

    it('gives up and cancels the job when the server stays unreachable', async () => {
        const unreachable = () => Promise.reject(new TypeError('Load failed'))
        const env = setup({ snapshot: Array(6).fill(unreachable) })
        const { text } = await startStream(env)
        env.sockets[0].drop()

        const result = text.catch((error: Error) => error)
        await vi.advanceTimersByTimeAsync(30_000)
        expect(env.deletes()).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(String(await result)).toContain('connection lost')
        expect(env.deletes()).toHaveLength(1)
    })

    it('gives up when the job stops moving and the socket keeps failing', async () => {
        const env = setup({
            snapshot: Array(6).fill(() => reply(200, { done: false, lastSeq: 1, events: [] })),
            onSocket: (socket) => {
                if (env.sockets.length > 1) {
                    setTimeout(() => socket.drop(), 0)
                }
            },
        })
        const { text } = await startStream(env)
        env.sockets[0].drop()

        const result = text.catch((error: Error) => error)
        await vi.advanceTimersByTimeAsync(31_000)
        expect(String(await result)).toContain('connection lost')
    })

    it('replaces a socket that stopped hearing pings', async () => {
        const env = setup({ snapshot: [() => reply(200, { done: false, lastSeq: 1, events: [] })] })
        await startStream(env)

        await vi.advanceTimersByTimeAsync(29_000)
        expect(env.sockets[0].closed).toBe(false)
        await vi.advanceTimersByTimeAsync(1_500)
        expect(env.sockets[0].closed).toBe(true)
        expect(env.sockets).toHaveLength(2)
        expect(env.sockets[1].url).toContain('since=1')
    })

    it('reconnects at once when the page wakes with a quiet socket, and keeps a live one', async () => {
        const env = setup({ snapshot: [() => reply(200, { done: false, lastSeq: 1, events: [] })] })
        await startStream(env)

        await vi.advanceTimersByTimeAsync(5_000)
        env.wake()
        await vi.advanceTimersByTimeAsync(0)
        expect(env.sockets).toHaveLength(1)

        await vi.advanceTimersByTimeAsync(15_000)
        env.wake()
        await vi.advanceTimersByTimeAsync(0)
        expect(env.sockets[0].closed).toBe(true)
        expect(env.sockets).toHaveLength(2)
    })

    it('errors the body instead of passing over missing events', async () => {
        const env = setup()
        const { text } = await startStream(env)
        env.sockets[0].emit(chunk(3, 'lo'))

        expect(String(await text.catch((error: Error) => error))).toContain('skipped events 2-2')
        expect(env.deletes()).toHaveLength(1)
    })

    it('cancels the job when the user stops mid-stream', async () => {
        const env = setup()
        const stop = new AbortController()
        const { text } = await startStream(env, { streamSignal: stop.signal })
        env.sockets[0].emit(chunk(2, 'Hel'))
        stop.abort()

        expect(await text).toBe('Hel')
        expect(env.deletes()).toHaveLength(1)
        expect(env.sockets[0].closed).toBe(true)
    })

    it('answers a failure before the response started with an error response', async () => {
        const env = setup()
        const pending = openProxyJobStream(streamOptions(), env.deps)
        await vi.advanceTimersByTimeAsync(0)
        env.sockets[0].emit({ type: 'error', seq: 1, status: 504, message: 'Gateway time-out' })

        const res = await pending
        expect(res.status).toBe(504)
        expect(await readText(res.body)).toContain('Cloudflare/origin timeout')
    })

    it('retries job creation under the same job ID', async () => {
        const env = setup({ create: [() => Promise.reject(new TypeError('Load failed'))] })
        const pending = openProxyJobStream(streamOptions(), env.deps)

        await vi.advanceTimersByTimeAsync(1_000)
        env.sockets[0].emit(headers(1))
        await pending
        const posts = env.requests.filter((request) => request.method === 'POST')
        expect(posts).toHaveLength(2)
        expect(posts[1].body?.jobId).toBe(posts[0].body?.jobId)
    })

    it('retries job creation when a gateway could not tell whether the server got it', async () => {
        const env = setup({ create: [() => reply(502, { error: 'Bad gateway' })] })
        const pending = openProxyJobStream(streamOptions(), env.deps)

        await vi.advanceTimersByTimeAsync(1_000)
        env.sockets[0].emit(headers(1))
        await pending
        expect(env.requests.filter((request) => request.method === 'POST')).toHaveLength(2)
    })

    it('marks a creation that may have reached the server so it is not sent another way', async () => {
        const unreachable = () => Promise.reject(new TypeError('Load failed'))
        const env = setup({ create: Array(4).fill(unreachable) })
        const result = openProxyJobStream(streamOptions(), env.deps).catch((error: Error) => error)

        await vi.advanceTimersByTimeAsync(7_000)
        expect(await result).toBeInstanceOf(ProxyJobCreateUncertainError)
        expect(env.deletes()).toHaveLength(1)
    })

    it('reports a creation the server refused as a plain error', async () => {
        const env = setup({ create: [() => reply(429, { error: 'Too many active stream jobs' })] })
        const error = await openProxyJobStream(streamOptions(), env.deps).catch((error: Error) => error)

        expect(error).toBeInstanceOf(Error)
        expect(error).not.toBeInstanceOf(ProxyJobCreateUncertainError)
        expect(env.requests).toHaveLength(1)
    })
})
