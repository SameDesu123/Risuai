import { flushSync } from 'svelte'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Database } from './database.svelte'
import { createSaveTracker } from './saveTracker.svelte'
import { RisuSaveDecoder, RisuSaveEncoder } from './risuSave'

vi.mock('./database.svelte', () => ({ getDatabase: () => ({ enableRemoteSaving: false }) }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: {} }))
vi.mock('../platform', () => ({ isTauri: false, isNodeServer: false }))
vi.mock('localforage', () => ({
    default: {
        createInstance: () => ({ setItem: vi.fn().mockResolvedValue(undefined) }),
    },
}))

function character(id: string) {
    return {
        chaId: id,
        name: id,
        chatPage: 0,
        chats: [0, 1].map(n => ({ id: `${id}-${n}`, message: [{ data: 'old' }] })),
    }
}

const state = $state({ db: {} as Database })
let tracker: ReturnType<typeof createSaveTracker>
let onChange = vi.fn<() => void>()

beforeEach(() => {
    state.db = {
        characters: [character('a'), character('b')],
        botPresets: [{ name: 'preset', prompt: { text: 'old' } }],
        modules: [{ name: 'module' }],
        loadouts: [{ name: 'loadout' }],
        plugins: [{ name: 'plugin' }],
        pluginCustomStorage: { plugin: { value: 1 } },
        username: 'old',
        custom: { nested: 1 },
    } as unknown as Database
    onChange = vi.fn()
    tracker = createSaveTracker(() => state.db, onChange)
    flushSync()
    tracker.snapshot().acknowledge()
    onChange.mockClear()
})

afterEach(() => tracker.dispose())

function snapshot() {
    flushSync()
    return tracker.snapshot()
}

test('tracks an unselected character and the actual edited chat, without unrelated targets', () => {
    state.db.characters[1].chats[1].message[0].data = 'new'
    const batch = snapshot()
    expect(batch.targets).toEqual(
        expect.arrayContaining([
            ['character', 'b'],
            ['chat', 'b', 'b-1'],
        ]),
    )
    expect(batch.targets).toHaveLength(2)
    expect(batch.toSave.character).toEqual(['b'])
    expect(batch.toSave.chat).toEqual([['b', 'b-1']])
})

test('tracks nested preset edits without changing the selected preset or array length', () => {
    state.db.botPresets[0].name = 'edited'
    expect(snapshot().targets).toEqual([['botPreset']])
})

test.each(['modules', 'loadouts', 'plugins', 'pluginCustomStorage'] as const)(
    'acknowledges %s and detects the next nested edit',
    key => {
        const edit = (value: number) => {
            if (key === 'pluginCustomStorage') state.db[key].plugin.value = value
            else state.db[key][0].name = String(value)
        }
        edit(2)
        const batch = snapshot()
        expect(batch.toSave[key]).toBe(true)
        batch.acknowledge()
        expect(snapshot().toSave[key]).toBe(false)
        edit(3)
        expect(snapshot().toSave[key]).toBe(true)
    },
)

test('reports root fields, including nested changes, additions and deletions', () => {
    state.db.username = 'new'
    state.db['custom'].nested++
    state.db['added'] = 1
    expect(snapshot().targets).toEqual(
        expect.arrayContaining([
            ['root', 'username'],
            ['root', 'custom'],
            ['root', 'added'],
        ]),
    )
    tracker.snapshot().acknowledge()
    delete state.db['added']
    expect(snapshot().targets).toEqual([['root', 'added']])
})

test('retains every dirty target on failure, even if the encoder consumes its input array', () => {
    state.db.characters[0].name = 'edited'
    state.db.botPresets[0].name = 'edited'
    const failed = snapshot()
    failed.toSave.character.splice(0)
    failed.targets.length = 0
    const retry = snapshot()
    expect(retry.toSave.character).toEqual(['a'])
    expect(retry.toSave.botPreset).toBe(true)
    retry.acknowledge()
    expect(snapshot().targets).toEqual([])
})

test('acknowledging an in-flight save preserves newer edits to the same targets', async () => {
    state.db.characters[0].chats[0].message[0].data = 'first'
    state.db.modules[0].name = 'first'
    state.db.username = 'first'
    const inFlight = snapshot()
    await Promise.resolve()
    state.db.characters[0].chats[0].message[0].data = 'second'
    state.db.modules[0].name = 'second'
    state.db.username = 'second'
    flushSync()
    inFlight.acknowledge()
    const next = snapshot()
    expect(next.targets).toHaveLength(4)
    expect(next.toSave.character).toEqual(['a'])
    expect(next.toSave.chat).toEqual([['a', 'a-0']])
    expect(next.toSave.modules).toBe(true)
    next.acknowledge()
    inFlight.acknowledge()
    expect(snapshot().targets).toEqual([])
})

test('deduplicates repeated edits and supports IDs containing separators', () => {
    state.db.characters[0].chaId = 'a/:"'
    state.db.characters[0].chats[0].id = 'chat/:"'
    snapshot().acknowledge()
    for (let n = 0; n < 3; n++) {
        state.db.characters[0].chats[0].message[0].data = String(n)
        flushSync()
    }
    const batch = snapshot()
    expect(batch.toSave.character).toEqual(['a/:"'])
    expect(batch.toSave.chat).toEqual([['a/:"', 'chat/:"']])
})

test('preserves observers on reorder and detaches removed characters', () => {
    state.db.characters.reverse()
    expect(snapshot().targets).toEqual([['root', 'characters']])
    tracker.snapshot().acknowledge()
    const removed = state.db.characters.pop()
    expect(snapshot().toSave.character).toEqual(['a'])
    tracker.snapshot().acknowledge()
    removed.chats[0].message[0].data = 'detached'
    expect(snapshot().targets).toEqual([])
    state.db.characters[0].chats[1].message[0].data = 'still watched'
    expect(snapshot().toSave.chat).toEqual([['b', 'b-1']])
})

test('tracks chat removal, replacement and metadata independently', () => {
    const chats = state.db.characters[0].chats
    const removed = chats.pop()
    expect(snapshot().toSave.chat).toEqual([['a', 'a-1']])
    tracker.snapshot().acknowledge()
    removed.message[0].data = 'detached'
    expect(snapshot().targets).toEqual([])
    chats[0] = { ...chats[0], message: [] }
    expect(snapshot().toSave.chat).toEqual([['a', 'a-0']])
    tracker.snapshot().acknowledge()
    state.db.characters[0].name = 'metadata only'
    expect(snapshot().targets).toEqual([['character', 'a']])
})

test('tracks character insertion, ID changes and replacement of the database', () => {
    state.db.characters.push(character('c') as unknown as Database['characters'][number])
    expect(snapshot().toSave.character).toEqual(['c'])
    tracker.snapshot().acknowledge()
    state.db.characters[2].chaId = 'new-c'
    expect(snapshot().toSave.character).toEqual(expect.arrayContaining(['c', 'new-c']))
    tracker.snapshot().acknowledge()
    const old = state.db
    state.db = { ...state.db, characters: [] }
    expect(snapshot().toSave.character).toEqual(expect.arrayContaining(['a', 'b', 'new-c']))
    tracker.snapshot().acknowledge()
    old.characters[0].name = 'detached'
    expect(snapshot().targets).toEqual([])
})

test('handles empty chats and missing chat IDs without emitting undefined targets', () => {
    state.db.characters[0].chats = []
    delete state.db.characters[1].chats[0].id
    snapshot().acknowledge()
    state.db.characters[0].name = 'empty'
    state.db.characters[1].chats[0].message[0].data = 'no id'
    const batch = snapshot()
    expect(batch.toSave.character).toEqual(expect.arrayContaining(['a', 'b']))
    expect(batch.toSave.chat).toEqual([])
})

test('does not notify on reads or same-value assignments, and disposes all observers', () => {
    state.db.characters[0].name = state.db.characters[0].name
    expect(snapshot().targets).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
    tracker.dispose()
    state.db.characters[0].chats[0].message[0].data = 'after dispose'
    expect(snapshot().targets).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
})

test('round-trips background edits and deletions through the real save encoder', async () => {
    const encoder = new RisuSaveEncoder()
    await encoder.init(state.db)
    state.db.characters[1].chats[1].message[0].data = 'saved in background'
    state.db.botPresets[0].name = 'saved preset'
    state.db.characters.splice(0, 1)
    const batch = snapshot()
    await encoder.set(state.db, batch.toSave)
    const restored = await new RisuSaveDecoder().decode(new Uint8Array(encoder.encode()))
    expect(restored.characters.map(c => c.chaId)).toEqual(['b'])
    expect(restored.characters[0].chats[1].message[0].data).toBe('saved in background')
    expect(restored.botPresets[0].name).toBe('saved preset')
    batch.acknowledge()
    expect(snapshot().targets).toEqual([])
})

test('retries a partially encoded batch without losing characters or block flags', async () => {
    const encoder = new RisuSaveEncoder()
    await encoder.init(state.db)
    state.db.characters[0].name = 'saved character'
    state.db.modules[0].name = 'saved module'
    const encode = encoder.encodeBlock.bind(encoder)
    vi.spyOn(encoder, 'encodeBlock')
        .mockImplementationOnce(encode)
        .mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(encoder.set(state.db, snapshot().toSave)).rejects.toThrow('storage unavailable')
    const retry = snapshot()
    expect(retry.toSave.character).toEqual(['a'])
    expect(retry.toSave.modules).toBe(true)
    await encoder.set(state.db, retry.toSave)
    const restored = await new RisuSaveDecoder().decode(new Uint8Array(encoder.encode()))
    expect(restored.characters[0].name).toBe('saved character')
    expect(restored.modules[0].name).toBe('saved module')
    retry.acknowledge()
    expect(snapshot().targets).toEqual([])
})
