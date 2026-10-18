// @vitest-environment node
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createProxyStreamJobStore, isValidProxyStreamJobId, normalizeSinceSeq } = require('./proxyStreamJobs.cjs')

function createClock(start = 1_000_000) {
    const clock = {
        time: start,
        now: () => clock.time
    }
    return clock
}

function createStore(clock = createClock(), overrides = {}) {
    return createProxyStreamJobStore({
        maxJobLogBytes: 1024 * 1024,
        maxTotalLogBytes: 4 * 1024 * 1024,
        maxRetainedJobs: 8,
        resultTtlMs: 60_000,
        now: clock.now,
        ...overrides
    })
}

function createJob(store: any, jobId?: string) {
    return store.create({
        jobId,
        requestHash: 'hash',
        heartbeatSec: 15,
        timeoutMs: 10_000,
        staleAfterMs: 30_000
    })
}

function createClient() {
    return {
        OPEN: 1,
        readyState: 1,
        sent: [] as string[],
        send(text: string) {
            this.sent.push(text)
        },
        close() {
            this.readyState = 3
        }
    }
}

function received(client: { sent: string[] }) {
    return client.sent.map((text) => JSON.parse(text))
}

describe('createProxyStreamJobStore', () => {
    it('numbers events and replays them from a given seq', () => {
        const store = createStore()
        const job = createJob(store)
        store.push(job, { type: 'upstream_headers', status: 200, headers: {} })
        store.push(job, { type: 'chunk', dataBase64: 'YQ==' })

        const client = createClient()
        store.attach(job, client, 1)
        store.push(job, { type: 'chunk', dataBase64: 'Yg==' })

        expect(received(client)).toEqual([
            { type: 'chunk', dataBase64: 'YQ==', seq: 2 },
            { type: 'chunk', dataBase64: 'Yg==', seq: 3 }
        ])
    })

    it('keeps a finished result after its client disconnects', () => {
        const store = createStore()
        const job = createJob(store)
        const client = createClient()
        store.attach(job, client, 0)
        store.push(job, { type: 'chunk', dataBase64: 'YQ==' })
        store.detach(job, client)
        store.push(job, { type: 'done' })

        const reconnected = createClient()
        store.attach(store.get(job.id), reconnected, 1)
        expect(received(reconnected)).toEqual([{ type: 'done', seq: 2 }])
        expect(store.push(job, { type: 'chunk', dataBase64: 'Yg==' })).toBe(false)
    })

    it('counts only running jobs against the active limit', () => {
        const store = createStore()
        const finished = createJob(store)
        createJob(store)
        store.push(finished, { type: 'done' })
        expect(store.countRunning()).toBe(1)
    })

    it('expires finished results after the TTL but not running jobs', () => {
        const clock = createClock()
        const store = createStore(clock)
        const finished = createJob(store)
        const running = createJob(store)
        store.push(finished, { type: 'done' })

        clock.time += 60_000
        store.push(running, { type: 'chunk', dataBase64: 'YQ==' })
        store.collectGarbage()

        expect(store.get(finished.id)).toBeUndefined()
        expect(store.get(running.id)).toBe(running)
    })

    it('aborts running jobs past their deadline and drops stalled ones', () => {
        const clock = createClock()
        const store = createStore(clock)
        const job = createJob(store)

        clock.time += 10_000
        store.collectGarbage()
        expect(job.abortController.signal.aborted).toBe(true)
        expect(store.get(job.id)).toBe(job)

        clock.time += 20_001
        store.collectGarbage()
        expect(store.get(job.id)).toBeUndefined()
    })

    it('fails a job with 507 instead of truncating it when it outgrows its buffer', () => {
        const store = createStore(createClock(), { maxJobLogBytes: 200 })
        const job = createJob(store)
        const client = createClient()
        store.attach(job, client, 0)

        expect(store.push(job, { type: 'chunk', dataBase64: 'a'.repeat(100) })).toBe(true)
        expect(store.push(job, { type: 'chunk', dataBase64: 'b'.repeat(100) })).toBe(false)

        const events = received(client)
        expect(events.at(-1)).toMatchObject({ type: 'error', status: 507, seq: 2 })
        expect(job.done).toBe(true)
        expect(job.abortController.signal.aborted).toBe(true)
    })

    it('evicts the oldest finished result to make room for a running job', () => {
        const clock = createClock()
        const store = createStore(clock, { maxTotalLogBytes: 400 })
        const older = createJob(store)
        store.push(older, { type: 'chunk', dataBase64: 'a'.repeat(100) })
        store.push(older, { type: 'done' })
        clock.time += 1
        const newer = createJob(store)
        store.push(newer, { type: 'done' })

        const running = createJob(store)
        expect(store.push(running, { type: 'chunk', dataBase64: 'b'.repeat(250) })).toBe(true)

        expect(store.get(older.id)).toBeUndefined()
        expect(store.get(newer.id)).toBe(newer)
        expect(store.totalLogBytes).toBeLessThanOrEqual(400)
    })

    it('limits how many finished results are retained', () => {
        const clock = createClock()
        const store = createStore(clock, { maxRetainedJobs: 2 })
        const jobs = [createJob(store), createJob(store), createJob(store)]
        for (const job of jobs) {
            clock.time += 1
            store.push(job, { type: 'done' })
        }

        expect(store.get(jobs[0].id)).toBeUndefined()
        expect(store.get(jobs[1].id)).toBe(jobs[1])
        expect(store.get(jobs[2].id)).toBe(jobs[2])
    })

    it('aborts, disconnects and frees a removed job', () => {
        const store = createStore()
        const job = createJob(store)
        const client = createClient()
        store.attach(job, client, 0)
        store.push(job, { type: 'chunk', dataBase64: 'YQ==' })

        store.remove(job.id)

        expect(store.get(job.id)).toBeUndefined()
        expect(job.abortController.signal.aborted).toBe(true)
        expect(client.readyState).toBe(3)
        expect(store.totalLogBytes).toBe(0)
        expect(store.push(job, { type: 'chunk', dataBase64: 'Yg==' })).toBe(false)
    })

    it('reuses a client-chosen job ID', () => {
        const store = createStore()
        const jobId = '123e4567-e89b-42d3-a456-426614174000'
        expect(createJob(store, jobId).id).toBe(jobId)
        expect(store.get(jobId)).toBeDefined()
    })

    it('serializes a snapshot from a given seq', () => {
        const store = createStore()
        const job = createJob(store)
        store.push(job, { type: 'chunk', dataBase64: 'YQ==' })
        store.push(job, { type: 'done' })

        expect(JSON.parse(store.snapshot(job, 1))).toEqual({
            jobId: job.id,
            done: true,
            lastSeq: 2,
            events: [{ type: 'done', seq: 2 }]
        })
    })
})

describe('isValidProxyStreamJobId', () => {
    it('accepts UUIDs only', () => {
        expect(isValidProxyStreamJobId('123e4567-e89b-42d3-a456-426614174000')).toBe(true)
        expect(isValidProxyStreamJobId('../etc/passwd')).toBe(false)
        expect(isValidProxyStreamJobId(42)).toBe(false)
    })
})

describe('normalizeSinceSeq', () => {
    it('falls back to 0 for missing or invalid values', () => {
        expect(normalizeSinceSeq('5')).toBe(5)
        expect(normalizeSinceSeq(null)).toBe(0)
        expect(normalizeSinceSeq('-3')).toBe(0)
        expect(normalizeSinceSeq('abc')).toBe(0)
    })
})
