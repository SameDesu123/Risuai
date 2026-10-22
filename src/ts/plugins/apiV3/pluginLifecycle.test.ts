import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCoalescedRunner, PluginUnloadRegistry, type PluginLifecycle } from './pluginLifecycle'

const deferred = () => {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

describe('PluginUnloadRegistry', () => {
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('runs every callback even when earlier ones throw or reject', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const registry = new PluginUnloadRegistry()
        const lifecycle: PluginLifecycle = { alive: true }
        const after = vi.fn()

        registry.add('a', lifecycle, () => {
            throw new Error('sync failure')
        })
        registry.add('a', lifecycle, async () => {
            throw new Error('async failure')
        })
        registry.add('a', lifecycle, after)

        await registry.run('a', lifecycle, 1000)

        expect(after).toHaveBeenCalledTimes(1)
        expect(lifecycle.alive).toBe(false)
    })

    it('stops waiting for a hanging callback after the timeout', async () => {
        vi.useFakeTimers()
        const registry = new PluginUnloadRegistry()
        const lifecycle: PluginLifecycle = { alive: true }
        registry.add('a', lifecycle, () => new Promise(() => {}))

        let finished = false
        const run = registry.run('a', lifecycle, 1000).then(() => {
            finished = true
        })

        await vi.advanceTimersByTimeAsync(999)
        expect(finished).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await run
        expect(finished).toBe(true)
    })

    it('immediately undoes registrations that finish after unloading started', async () => {
        const registry = new PluginUnloadRegistry()
        const lifecycle: PluginLifecycle = { alive: true }
        await registry.run('a', lifecycle, 1000)

        const lateCleanup = vi.fn()
        registry.add('a', lifecycle, lateCleanup)
        expect(lateCleanup).toHaveBeenCalledTimes(1)

        // The late cleanup must not leak into the next instance with the same name.
        const nextLifecycle: PluginLifecycle = { alive: true }
        const nextCleanup = vi.fn()
        registry.add('a', nextLifecycle, nextCleanup)
        await registry.run('a', nextLifecycle, 1000)
        expect(lateCleanup).toHaveBeenCalledTimes(1)
        expect(nextCleanup).toHaveBeenCalledTimes(1)
    })

    it('keeps callbacks of different plugins apart', async () => {
        const registry = new PluginUnloadRegistry()
        const a: PluginLifecycle = { alive: true }
        const b: PluginLifecycle = { alive: true }
        const cleanupA = vi.fn()
        const cleanupB = vi.fn()
        registry.add('a', a, cleanupA)
        registry.add('b', b, cleanupB)

        await registry.run('a', a, 1000)

        expect(cleanupA).toHaveBeenCalledTimes(1)
        expect(cleanupB).not.toHaveBeenCalled()
        expect(b.alive).toBe(true)
    })
})

describe('createCoalescedRunner', () => {
    it('never runs the task concurrently and coalesces calls made during a run', async () => {
        const gates = [deferred(), deferred()]
        let active = 0
        let maxActive = 0
        let runs = 0
        const runner = createCoalescedRunner(async () => {
            const gate = gates[runs++]
            active++
            maxActive = Math.max(maxActive, active)
            await gate.promise
            active--
        })

        const first = runner()
        const second = runner()
        const third = runner()
        expect(second).toBe(third)
        expect(runs).toBe(1)

        gates[0].resolve()
        await first
        await vi.waitFor(() => expect(runs).toBe(2))

        gates[1].resolve()
        await second
        expect(runs).toBe(2)
        expect(maxActive).toBe(1)
    })

    it('resolves a queued caller only after a run that started after its call', async () => {
        const gate = deferred()
        const order: string[] = []
        let runs = 0
        const runner = createCoalescedRunner(async () => {
            const run = ++runs
            order.push(`start ${run}`)
            if (run === 1) {
                await gate.promise
            }
            order.push(`end ${run}`)
        })

        runner()
        const queued = runner().then(() => order.push('queued resolved'))
        gate.resolve()
        await queued

        expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'queued resolved'])
    })

    it('keeps working after a run fails', async () => {
        const gate = deferred()
        let runs = 0
        const runner = createCoalescedRunner(async () => {
            runs++
            if (runs === 1) {
                await gate.promise
                throw new Error('load failed')
            }
        })

        const failing = runner()
        const queued = runner()
        gate.resolve()

        await expect(failing).rejects.toThrow('load failed')
        await expect(queued).resolves.toBeUndefined()
        expect(runs).toBe(2)

        await expect(runner()).resolves.toBeUndefined()
        expect(runs).toBe(3)
    })
})
