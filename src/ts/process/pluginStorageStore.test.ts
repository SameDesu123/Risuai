import { describe, expect, test } from 'vitest'
import { PLUGIN_STORAGE_INDEX_KEY, PluginStorageStore, isPluginStorageIndex, type PluginStorageBackend } from './pluginStorageStore'

function createBackend() {
    const items = new Map<string, unknown>()
    let seq = 0
    //when set, the next write waits for this promise before it lands
    let gate: Promise<void> | null = null
    const backend: PluginStorageBackend = {
        get: async (id) => items.get(id) ?? null,
        set: async (id, value) => {
            if (gate) {
                const wait = gate
                gate = null
                await wait
            }
            items.set(id, JSON.parse(JSON.stringify(value)))
            return true
        },
        remove: async (ids) => {
            for (const id of ids) {
                items.delete(id)
            }
        },
        newId: () => `id-${++seq}`,
        now: () => 0,
    }
    const holdNextWrite = () => {
        let release!: () => void
        gate = new Promise<void>((resolve) => {
            release = resolve
        })
        return release
    }
    return { backend, items, holdNextWrite }
}

function createStore(initial: Record<string, any> | undefined) {
    const db: { pluginCustomStorage?: Record<string, any> } = { pluginCustomStorage: initial }
    const { backend, items, holdNextWrite } = createBackend()
    const store = new PluginStorageStore(
        backend,
        () => db.pluginCustomStorage,
        () => (db.pluginCustomStorage ??= {}),
        //no timer flushes during the tests; flush() is called explicitly
        { flushDelay: 60_000, maxFlushDelay: 60_000 },
    )
    return { db, store, items, holdNextWrite }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('PluginStorageStore flush commit', () => {
    test('commits the new index when the pointer is unchanged', async () => {
        const { db, store, items } = createStore(undefined)
        await store.setItem('a', 1)
        await store.flush()
        const pointer = db.pluginCustomStorage?.[PLUGIN_STORAGE_INDEX_KEY]
        expect(typeof pointer).toBe('string')
        expect(isPluginStorageIndex(items.get(pointer))).toBe(true)
        expect(await store.getItem('a')).toBe(1)
    })

    test('does not overwrite a pointer that was replaced while the index was written', async () => {
        const { db, store, items, holdNextWrite } = createStore(undefined)
        await store.setItem('a', 'old')
        await store.flush()
        const oldPointer = db.pluginCustomStorage![PLUGIN_STORAGE_INDEX_KEY]

        //the restored database brings its own index
        items.set('restored-index', { type: 'risu-plugin-storage-index', version: 1, entries: [{ k: 'a', s: '"restored"' }], trash: [] })

        await store.setItem('a', 'changed')
        const release = holdNextWrite()
        const flushing = store.flush()
        await tick()
        db.pluginCustomStorage = { [PLUGIN_STORAGE_INDEX_KEY]: 'restored-index' }
        release()
        await flushing

        expect(db.pluginCustomStorage[PLUGIN_STORAGE_INDEX_KEY]).toBe('restored-index')
        //the uncommitted index is deleted, the old and restored ones are kept
        expect([...items.keys()].sort()).toEqual([oldPointer, 'restored-index'].sort())
        //the store reloads from the replaced database
        expect(await store.getItem('a')).toBe('restored')
    })

    test('does not commit into a database replaced before the flush started', async () => {
        const { db, store, items } = createStore(undefined)
        await store.setItem('a', 'old')
        await store.flush()
        await store.setItem('a', 'changed')

        db.pluginCustomStorage = {}
        await store.flush()

        expect(db.pluginCustomStorage[PLUGIN_STORAGE_INDEX_KEY]).toBeUndefined()
        expect(items.size).toBe(1)
        expect(await store.getItem('a')).toBeNull()
    })

    test('still commits the legacy migration (no pointer yet)', async () => {
        const { db, store, items } = createStore({ a: 1, b: { c: 'd' } })
        await store.load()
        const pointer = db.pluginCustomStorage![PLUGIN_STORAGE_INDEX_KEY]
        expect(typeof pointer).toBe('string')
        expect(isPluginStorageIndex(items.get(pointer))).toBe(true)
        expect(db.pluginCustomStorage!.a).toBeUndefined()
        expect(await store.getItem('b')).toEqual({ c: 'd' })
    })
})

describe('PluginStorageStore suspend', () => {
    test('turns flush into a no-op', async () => {
        const { db, store, items } = createStore(undefined)
        await store.setItem('a', 1)
        store.suspend()
        await store.flush()
        expect(db.pluginCustomStorage?.[PLUGIN_STORAGE_INDEX_KEY]).toBeUndefined()
        expect(items.size).toBe(0)
    })

    test('drops a flush that was in flight when suspended', async () => {
        const { db, store, items, holdNextWrite } = createStore(undefined)
        await store.setItem('a', 1)
        const release = holdNextWrite()
        const flushing = store.flush()
        await tick()
        store.suspend()
        release()
        await flushing
        expect(db.pluginCustomStorage?.[PLUGIN_STORAGE_INDEX_KEY]).toBeUndefined()
        expect(items.size).toBe(0)
    })
})
