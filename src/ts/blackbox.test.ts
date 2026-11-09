import { describe, expect, it } from 'vitest'
import {
    HEURISTIC_DEAD_MS,
    blackboxLockName,
    buildBlackboxReport,
    findDeadRecords,
    pushRing,
    type BlackboxRecord,
} from './blackbox'

function makeRecord(over: Partial<BlackboxRecord> = {}): BlackboxRecord {
    return {
        v: 1,
        id: 'a',
        startedAt: 0,
        lastWrite: 0,
        clean: false,
        visible: true,
        meta: {
            appVersion: 'test',
            userAgent: 'test',
            heapLimitMB: 4000,
            crossOriginIsolated: false,
        },
        samples: [],
        crumbs: [],
        ...over,
    }
}

describe('pushRing', () => {
    it('keeps only the newest items', () => {
        const arr = [1, 2, 3]
        pushRing(arr, 4, 3)
        expect(arr).toEqual([2, 3, 4])
    })
})

describe('findDeadRecords', () => {
    it('ignores clean records and the current session', () => {
        const records = [makeRecord({ id: 'clean', clean: true }), makeRecord({ id: 'me' })]
        expect(findDeadRecords({ records, currentId: 'me', now: 0, heldLocks: new Set() })).toEqual([])
    })

    it('treats a record whose lock is not held as dead', () => {
        const alive = makeRecord({ id: 'alive' })
        const dead = makeRecord({ id: 'dead' })
        const result = findDeadRecords({
            records: [alive, dead],
            currentId: 'me',
            now: 0,
            heldLocks: new Set([blackboxLockName('alive')]),
        })
        expect(result).toEqual([dead])
    })

    it('falls back to the age of the last write without Web Locks', () => {
        const now = 10 * HEURISTIC_DEAD_MS
        const recent = makeRecord({ id: 'recent', lastWrite: now - 1000 })
        const old = makeRecord({ id: 'old', lastWrite: now - HEURISTIC_DEAD_MS - 1 })
        expect(findDeadRecords({ records: [recent, old], currentId: 'me', now, heldLocks: null })).toEqual([old])
    })
})

describe('buildBlackboxReport', () => {
    const ctx = { now: 5, liveness: 'locks' as const, prevTabId: null, wasDiscarded: true, navigationType: 'reload' }

    it('classifies by the last known visibility', () => {
        expect(buildBlackboxReport(makeRecord({ visible: true }), ctx).verdict).toBe('crashed-while-visible')
        expect(buildBlackboxReport(makeRecord({ visible: false }), ctx).verdict).toBe('killed-in-background')
    })

    it('only attaches tab restore details to the same tab', () => {
        const other = buildBlackboxReport(makeRecord({ id: 'a' }), { ...ctx, prevTabId: 'b' })
        expect(other.sameTab).toBe(false)
        expect(other.wasDiscarded).toBeNull()
        expect(other.navigationType).toBeNull()

        const same = buildBlackboxReport(makeRecord({ id: 'a' }), { ...ctx, prevTabId: 'a' })
        expect(same.sameTab).toBe(true)
        expect(same.wasDiscarded).toBe(true)
        expect(same.navigationType).toBe('reload')
    })

    it('computes the heap ratio of the last sample', () => {
        const record = makeRecord({
            samples: [{
                t: 0, visible: true, heapUsedMB: 3000, domNodes: 0, images: 0, imageEstMB: 0,
                canvasMB: 0, iframes: 0, lagMs: 0, activity: [], counters: {},
            }],
        })
        expect(buildBlackboxReport(record, ctx).lastHeapRatio).toBe(0.75)
        expect(buildBlackboxReport(makeRecord(), ctx).lastHeapRatio).toBeNull()
    })
})
