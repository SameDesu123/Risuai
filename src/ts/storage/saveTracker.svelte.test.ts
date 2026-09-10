import { flushSync } from 'svelte'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { character as Character, Database } from './database.svelte'
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
        triggerscript: [{ type: 'start', conditions: [], effect: [{ type: 'triggerlua', code: 'return 0' }] }],
        globalLore: [{ key: 'lore', content: 'old' }],
        chats: [0, 1].map(n => ({
            id: `${id}-${n}`,
            message: [{ data: 'old' }],
            localLore: [{ content: 'old' }],
            supaMemoryData: 'old',
            scriptstate: { count: 0 },
            note: 'old',
        })),
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
    tracker.takeBatch().acknowledge()
    onChange.mockClear()
})

afterEach(() => tracker.dispose())

function changes() {
    flushSync()
    return tracker.takeBatch()
}

test('tracks an unselected character and the actual edited chat, without unrelated targets', () => {
    state.db.characters[1].chats[1].message[0].data = 'new'
    const batch = changes()
    expect(batch.targets).toEqual([['chat', 'b', 'b-1', 'message']])
    expect(batch.toSave.character).toEqual(['b'])
    expect(batch.toSave.chat).toEqual([['b', 'b-1']])
})

test('tracks nested preset edits without changing the selected preset or array length', () => {
    state.db.botPresets[0].name = 'edited'
    expect(changes().targets).toEqual([['botPreset']])
})

test('reports Lua and character lorebook sections without marking unrelated chat sections', () => {
    const bot = state.db.characters[1] as Character
    bot.triggerscript[0].effect[0]['code'] = 'return 1'
    expect(changes().targets).toEqual([['character', 'b', 'triggerscript']])
    tracker.takeBatch().acknowledge()
    bot.globalLore[0].content = 'new lore'
    expect(changes().targets).toEqual([['character', 'b', 'globalLore']])
})

test.each(['localLore', 'supaMemoryData', 'scriptstate', 'note'] as const)(
    'distinguishes chat %s from messages and deduplicates legacy save targets',
    field => {
        const chat = state.db.characters[1].chats[1]
        if (field === 'localLore') chat.localLore[0].content = 'new'
        else if (field === 'scriptstate') chat.scriptstate.count = 1
        else chat[field] = 'new'
        expect(changes().targets).toEqual([['chat', 'b', 'b-1', field]])
        chat.message[0].data = 'new'
        const batch = changes()
        expect(batch.targets).toHaveLength(2)
        expect(batch.toSave.character).toEqual(['b'])
        expect(batch.toSave.chat).toEqual([['b', 'b-1']])
    },
)

test('automatically watches added sections, detaches deleted sections, and retains replacements', () => {
    const chat = state.db.characters[0].chats[0]
    chat['futureSection'] = { nested: { value: 0 } }
    expect(changes().targets).toEqual([['chat', 'a', 'a-0', 'futureSection']])
    tracker.takeBatch().acknowledge()
    const removed = chat['futureSection']
    delete chat['futureSection']
    expect(changes().targets).toEqual([['chat', 'a', 'a-0', 'futureSection']])
    tracker.takeBatch().acknowledge()
    removed.nested.value++
    expect(changes().targets).toEqual([])
    chat['futureSection'] = { nested: { value: 1 } }
    changes().acknowledge()
    chat['futureSection'].nested.value++
    expect(changes().targets).toEqual([['chat', 'a', 'a-0', 'futureSection']])
})

test('message edits do not re-read lorebooks or other chat sections and preserve state identity', () => {
    const bot = state.db.characters[0]
    const chat = bot.chats[0]
    const readLore = vi.fn(() => 'lore')
    const readMemory = vi.fn(() => 'memory')
    bot.globalLore = [
        {
            get content() {
                return readLore()
            },
        },
    ] as Character['globalLore']
    chat['futureMemory'] = {
        get data() {
            return readMemory()
        },
    }
    changes().acknowledge()
    readLore.mockClear()
    readMemory.mockClear()
    const message = chat.message[0]
    message.data = 'edited through existing reference'
    expect(changes().targets).toEqual([['chat', 'a', 'a-0', 'message']])
    expect(readLore).not.toHaveBeenCalled()
    expect(readMemory).not.toHaveBeenCalled()
    expect(state.db.characters[0]).toBe(bot)
    expect(bot.chats[0]).toBe(chat)
    expect(chat.message[0]).toBe(message)
})

test('observes array length, nested deletion and shared references without invoking serialization', () => {
    const serialize = vi.fn()
    const shared = { value: 0 }
    state.db['custom'] = { a: shared, b: shared, list: [], toJSON: serialize }
    changes().acknowledge()
    state.db['custom'].list.length = 2
    expect(changes().targets).toEqual([['root', 'custom']])
    tracker.takeBatch().acknowledge()
    delete state.db['custom'].a
    changes().acknowledge()
    state.db['custom'].b.value++
    expect(changes().targets).toEqual([['root', 'custom']])
    expect(serialize).not.toHaveBeenCalled()
})

test('acknowledges sections independently when a different section changes during saving', () => {
    const chat = state.db.characters[0].chats[0]
    chat.message[0].data = 'first'
    const saved = changes()
    chat.note = 'during save'
    flushSync()
    saved.acknowledge()
    expect(changes().targets).toEqual([['chat', 'a', 'a-0', 'note']])
})

test.each(['modules', 'loadouts', 'plugins', 'pluginCustomStorage'] as const)(
    'acknowledges %s and detects the next nested edit',
    key => {
        const edit = (value: number) => {
            if (key === 'pluginCustomStorage') state.db[key].plugin.value = value
            else state.db[key][0].name = String(value)
        }
        edit(2)
        const batch = changes()
        expect(batch.toSave[key]).toBe(true)
        batch.acknowledge()
        expect(changes().toSave[key]).toBe(false)
        edit(3)
        expect(changes().toSave[key]).toBe(true)
    },
)

test('reports root fields, including nested changes, additions and deletions', () => {
    state.db.username = 'new'
    state.db['custom'].nested++
    state.db['added'] = 1
    expect(changes().targets).toEqual(
        expect.arrayContaining([
            ['root', 'username'],
            ['root', 'custom'],
            ['root', 'added'],
        ]),
    )
    tracker.takeBatch().acknowledge()
    delete state.db['added']
    expect(changes().targets).toEqual([['root', 'added']])
})

test('retains every dirty target on failure, even if the encoder consumes its input array', () => {
    state.db.characters[0].name = 'edited'
    state.db.botPresets[0].name = 'edited'
    const failed = changes()
    failed.toSave.character.splice(0)
    failed.targets.length = 0
    const retry = changes()
    expect(retry.toSave.character).toEqual(['a'])
    expect(retry.toSave.botPreset).toBe(true)
    retry.acknowledge()
    expect(changes().targets).toEqual([])
})

test('acknowledging an in-flight save preserves newer edits to the same targets', async () => {
    state.db.characters[0].chats[0].message[0].data = 'first'
    state.db.modules[0].name = 'first'
    state.db.username = 'first'
    const inFlight = changes()
    await Promise.resolve()
    state.db.characters[0].chats[0].message[0].data = 'second'
    state.db.modules[0].name = 'second'
    state.db.username = 'second'
    flushSync()
    inFlight.acknowledge()
    const next = changes()
    expect(next.targets).toHaveLength(3)
    expect(next.toSave.character).toEqual(['a'])
    expect(next.toSave.chat).toEqual([['a', 'a-0']])
    expect(next.toSave.modules).toBe(true)
    next.acknowledge()
    inFlight.acknowledge()
    expect(changes().targets).toEqual([])
})

test('deduplicates repeated edits and supports IDs containing separators', () => {
    state.db.characters[0].chaId = 'a/:"'
    state.db.characters[0].chats[0].id = 'chat/:"'
    changes().acknowledge()
    for (let n = 0; n < 3; n++) {
        state.db.characters[0].chats[0].message[0].data = String(n)
        flushSync()
    }
    const batch = changes()
    expect(batch.toSave.character).toEqual(['a/:"'])
    expect(batch.toSave.chat).toEqual([['a/:"', 'chat/:"']])
})

test('preserves observers on reorder and detaches removed characters', () => {
    state.db.characters.reverse()
    expect(changes().targets).toEqual([['root', 'characters']])
    tracker.takeBatch().acknowledge()
    const removed = state.db.characters.pop()
    expect(changes().toSave.character).toEqual(['a'])
    tracker.takeBatch().acknowledge()
    removed.chats[0].message[0].data = 'detached'
    expect(changes().targets).toEqual([])
    state.db.characters[0].chats[1].message[0].data = 'still watched'
    expect(changes().toSave.chat).toEqual([['b', 'b-1']])
})

test('tracks chat removal, replacement and metadata independently', () => {
    const chats = state.db.characters[0].chats
    const removed = chats.pop()
    expect(changes().toSave.chat).toEqual([['a', 'a-1']])
    tracker.takeBatch().acknowledge()
    removed.message[0].data = 'detached'
    expect(changes().targets).toEqual([])
    chats[0] = { ...chats[0], message: [] }
    expect(changes().toSave.chat).toEqual([['a', 'a-0']])
    tracker.takeBatch().acknowledge()
    state.db.characters[0].name = 'metadata only'
    expect(changes().targets).toEqual([['character', 'a', 'name']])
})

test('tracks character insertion, ID changes and replacement of the database', () => {
    state.db.characters.push(character('c') as unknown as Database['characters'][number])
    expect(changes().toSave.character).toEqual(['c'])
    tracker.takeBatch().acknowledge()
    state.db.characters[2].chaId = 'new-c'
    expect(changes().toSave.character).toEqual(expect.arrayContaining(['c', 'new-c']))
    tracker.takeBatch().acknowledge()
    const old = state.db
    state.db = { ...state.db, characters: [] }
    expect(changes().toSave.character).toEqual(expect.arrayContaining(['a', 'b', 'new-c']))
    tracker.takeBatch().acknowledge()
    old.characters[0].name = 'detached'
    expect(changes().targets).toEqual([])
})

test('handles empty chats and missing chat IDs without emitting undefined targets', () => {
    state.db.characters[0].chats = []
    delete state.db.characters[1].chats[0].id
    changes().acknowledge()
    state.db.characters[0].name = 'empty'
    state.db.characters[1].chats[0].message[0].data = 'no id'
    const batch = changes()
    expect(batch.toSave.character).toEqual(expect.arrayContaining(['a', 'b']))
    expect(batch.toSave.chat).toEqual([])
})

test('does not notify on reads or same-value assignments, and disposes all observers', () => {
    state.db.characters[0].name = state.db.characters[0].name
    expect(changes().targets).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
    tracker.dispose()
    state.db.characters[0].chats[0].message[0].data = 'after dispose'
    expect(changes().targets).toEqual([])
    expect(onChange).not.toHaveBeenCalled()
})

test('round-trips background edits and deletions through the real save encoder', async () => {
    const encoder = new RisuSaveEncoder()
    await encoder.init(state.db)
    state.db.characters[1].chats[1].message[0].data = 'saved in background'
    state.db.botPresets[0].name = 'saved preset'
    state.db.characters.splice(0, 1)
    const batch = changes()
    await encoder.set(state.db, batch.toSave)
    const restored = await new RisuSaveDecoder().decode(new Uint8Array(encoder.encode()))
    expect(restored.characters.map(c => c.chaId)).toEqual(['b'])
    expect(restored.characters[0].chats[1].message[0].data).toBe('saved in background')
    expect(restored.botPresets[0].name).toBe('saved preset')
    batch.acknowledge()
    expect(changes().targets).toEqual([])
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
    await expect(encoder.set(state.db, changes().toSave)).rejects.toThrow('storage unavailable')
    const retry = changes()
    expect(retry.toSave.character).toEqual(['a'])
    expect(retry.toSave.modules).toBe(true)
    await encoder.set(state.db, retry.toSave)
    const restored = await new RisuSaveDecoder().decode(new Uint8Array(encoder.encode()))
    expect(restored.characters[0].name).toBe('saved character')
    expect(restored.modules[0].name).toBe('saved module')
    retry.acknowledge()
    expect(changes().targets).toEqual([])
})
