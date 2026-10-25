import { describe, expect, it, vi } from 'vitest'
import { PLUGIN_STORAGE_INDEX_KEY, PluginStorageStore, type PluginStorageBackend, type PluginStorageIndex } from './pluginStorageStore'

const DAY = 24 * 60 * 60 * 1000

//ids stay unique across the stores of one test, like UUIDs would
let seq = 0

function createBackend(items: Map<string, unknown>, clock: { now: number }) {
    return {
        get: vi.fn(async (id: string) => items.get(id)),
        set: vi.fn(async (id: string, value: unknown) => {
            items.set(id, structuredClone(value))
            return true
        }),
        remove: vi.fn(async (ids: string[]) => {
            for (const id of ids) {
                items.delete(id)
            }
            return [] as string[]
        }),
        newId: () => `id-${++seq}`,
        now: () => clock.now,
    } satisfies PluginStorageBackend
}

const options = { largeThreshold: 16, alwaysSmallSize: 0, flushDelay: 0, maxFlushDelay: 0 }

/** Leaves a replaced large item and the previous index in the trash of the saved index. */
async function seed() {
    const items = new Map<string, unknown>()
    const clock = { now: 0 }
    const storage: Record<string, any> = {}
    const store = new PluginStorageStore(createBackend(items, clock), () => storage, () => storage, options)
    await store.setItem('big', 'x'.repeat(100))
    await store.flush()
    await store.setItem('big', 'y'.repeat(100))
    await store.flush()
    const index = items.get(storage[PLUGIN_STORAGE_INDEX_KEY]) as PluginStorageIndex
    const trashed = index.trash.map((item) => item.id)
    expect(trashed.length).toBe(2)
    clock.now = 2 * DAY
    return { items, clock, storage, trashed }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('PluginStorageStore trash collection', () => {
    it('deletes trash items whose grace period passed', async () => {
        const { items, clock, storage, trashed } = await seed()
        const backend = createBackend(items, clock)
        const store = new PluginStorageStore(backend, () => storage, () => storage, options)
        await store.load()
        await settle()
        expect(backend.remove).toHaveBeenCalledWith(trashed)
        expect(trashed.some((id) => items.has(id))).toBe(false)
        expect(store.protectedIds()).not.toContain(trashed[0])
    })

    it('keeps items whose deletion failed in the trash and retries them on a later load', async () => {
        const { items, clock, storage, trashed } = await seed()
        const failing = createBackend(items, clock)
        failing.remove.mockImplementation(async (ids: string[]) => ids.slice(0, 1))
        const store = new PluginStorageStore(failing, () => storage, () => storage, options)
        await store.load()
        await settle()
        expect(store.protectedIds().filter((id) => trashed.includes(id))).toEqual(trashed.slice(0, 1))

        //the next index written keeps the failed id in its trash, without duplicates
        await store.setItem('other', 1)
        await store.flush()
        const index = items.get(storage[PLUGIN_STORAGE_INDEX_KEY]) as PluginStorageIndex
        expect(index.trash.filter((item) => item.id === trashed[0]).length).toBe(1)

        const retry = createBackend(items, clock)
        const reloaded = new PluginStorageStore(retry, () => storage, () => storage, options)
        await reloaded.load()
        await settle()
        expect(retry.remove.mock.calls[0][0]).toContain(trashed[0])
    })

    it('treats a rejected remove as all items failed', async () => {
        const { items, clock, storage, trashed } = await seed()
        const failing = createBackend(items, clock)
        failing.remove.mockRejectedValue(new Error('offline'))
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const store = new PluginStorageStore(failing, () => storage, () => storage, options)
        await store.load()
        await settle()
        expect(store.protectedIds()).toEqual(expect.arrayContaining(trashed))
        vi.restoreAllMocks()
    })

    it('writes a new index when a flush committed before the removal failed', async () => {
        const { items, clock, storage, trashed } = await seed()
        const failing = createBackend(items, clock)
        let finishRemove: (failed: string[]) => void = () => {}
        failing.remove.mockImplementation((ids: string[]) => new Promise<string[]>((resolve) => {
            finishRemove = () => resolve(ids)
        }))
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const store = new PluginStorageStore(failing, () => storage, () => storage, options)
        await store.load()

        //this index is written while the removal is still running, so its trash lacks the due ids
        await store.setItem('other', 1)
        await store.flush()
        const before = items.get(storage[PLUGIN_STORAGE_INDEX_KEY]) as PluginStorageIndex
        expect(before.trash.some((item) => trashed.includes(item.id))).toBe(false)

        finishRemove(trashed)
        await settle()
        await settle()
        const after = items.get(storage[PLUGIN_STORAGE_INDEX_KEY]) as PluginStorageIndex
        expect(after.trash.map((item) => item.id)).toEqual(expect.arrayContaining(trashed))
        vi.restoreAllMocks()
    })
})
