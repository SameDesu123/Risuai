import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
    return {
        platform: { isTauri: false, isNodeServer: false },
        dbSettings: { enableRemoteSaving: false } as Record<string, any>,
        /** risuSaveCache localforage instance */
        cache: new Map<string, any>(),
        /** forageStorage (remote block files on web/node) */
        forage: new Map<string, any>(),
        /** tauri AppData files, by path */
        fs: new Map<string, Uint8Array>(),
        dirs: new Set<string>(),
    }
})

vi.mock('@tauri-apps/plugin-fs', () => ({
    writeFile: vi.fn(async (path: string, data: Uint8Array) => {
        mocks.fs.set(path, new Uint8Array(data))
    }),
    exists: vi.fn(async (path: string) => mocks.fs.has(path) || mocks.dirs.has(path)),
    mkdir: vi.fn(async (path: string) => {
        mocks.dirs.add(path)
    }),
    readFile: vi.fn(async (path: string) => {
        if (!mocks.fs.has(path)) {
            throw new Error(`not found: ${path}`)
        }
        return mocks.fs.get(path)
    }),
    readDir: vi.fn(async (dir: string) => {
        return [...mocks.fs.keys()]
            .filter((path) => path.startsWith(dir + '/'))
            .map((path) => ({ name: path.slice(dir.length + 1), isFile: true, isDirectory: false, isSymlink: false }))
    }),
    rename: vi.fn(async (from: string, to: string) => {
        if (!mocks.fs.has(from)) {
            throw new Error(`not found: ${from}`)
        }
        mocks.fs.set(to, mocks.fs.get(from))
        mocks.fs.delete(from)
    }),
    BaseDirectory: { AppData: 0 },
}))

vi.mock('localforage', () => ({
    default: {
        createInstance: () => ({
            getItem: async (key: string) => mocks.cache.get(key) ?? null,
            setItem: async (key: string, value: any) => {
                mocks.cache.set(key, value)
                return value
            },
        }),
    },
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        getItem: async (key: string) => mocks.forage.get(key) ?? null,
        setItem: async (key: string, value: any) => {
            mocks.forage.set(key, value)
        },
        keys: vi.fn(async () => [...mocks.forage.keys()]),
    },
}))

vi.mock('./database.svelte', () => ({
    getDatabase: () => mocks.dbSettings,
    presetTemplate: { name: 'template preset' },
}))

vi.mock('src/ts/platform', () => ({
    get isTauri() {
        return mocks.platform.isTauri
    },
    get isNodeServer() {
        return mocks.platform.isNodeServer
    },
}))

import * as tauriFs from '@tauri-apps/plugin-fs'
import { forageStorage } from '../globalApi.svelte'
import { RisuSaveDecoder, RisuSaveEncoder, decodeRisuSave, encodeRisuSave, isRemoteSaveFileInUse, resetRemoteSaveSession, type toSaveType } from './risuSave'

const TYPE = {
    ROOT: 1,
    CHARACTER_WITH_CHAT: 2,
    CHAT: 3,
    REMOTE: 6,
    CHARACTER_WITHOUT_CHAT: 7,
}

const header = new TextEncoder().encode('RISUSAVE\0')

type ParsedBlock = {
    type: number
    name: string
    compressed: boolean
    /** the whole encoded block, for byte comparisons */
    raw: Uint8Array
    content: string
}

function parseBlocks(file: ArrayBuffer | Uint8Array): ParsedBlock[] {
    const data = new Uint8Array(file)
    const blocks: ParsedBlock[] = []
    let offset = header.length
    while (offset < data.length) {
        const start = offset
        const type = data[offset]
        const compressed = data[offset + 1] === 1
        const nameLength = data[offset + 2]
        offset += 3
        const name = new TextDecoder().decode(data.subarray(offset, offset + nameLength))
        offset += nameLength
        const length = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true)
        offset += 4
        const content = new TextDecoder().decode(data.subarray(offset, offset + length))
        offset += length
        blocks.push({ type, name, compressed, raw: data.slice(start, offset), content })
    }
    return blocks
}

function assembleBlocks(blocks: Uint8Array[]) {
    const total = header.length + blocks.reduce((a, b) => a + b.length, 0)
    const out = new Uint8Array(total)
    out.set(header, 0)
    let offset = header.length
    for (const block of blocks) {
        out.set(block, offset)
        offset += block.length
    }
    return out
}

function blockMap(file: ArrayBuffer | Uint8Array) {
    return new Map(parseBlocks(file).map((b) => [b.name, b]))
}

function makeMessages(count: number, prefix = 'msg') {
    const messages = []
    for (let i = 0; i < count; i++) {
        messages.push({
            role: i % 2 === 0 ? 'user' : 'char',
            data: `${prefix} ${i} ` + 'lorem ipsum '.repeat(5),
            time: 1700000000000 + i,
            chatId: `${prefix}-${i}`,
        })
    }
    return messages
}

function makeChat(id: string | undefined, name: string, messages: any[]) {
    const chat: any = {
        message: messages,
        note: `note of ${name}`,
        name,
        localLore: [],
        fmIndex: -1,
        scriptstate: { counter: 1, flag: true },
    }
    if (id !== undefined) {
        chat.id = id
    }
    return chat
}

function makeCharacter(chaId: string, chats: any[], extra: Record<string, any> = {}) {
    return {
        type: 'character',
        chaId,
        name: `Character ${chaId}`,
        firstMessage: 'Hello',
        desc: 'description',
        chats,
        chatPage: 0,
        customscript: [],
        globalLore: [],
        emotionImages: [],
        ...extra,
    }
}

function makeDatabase(): any {
    return {
        username: 'tester',
        mainPrompt: 'main prompt',
        formatversion: 5,
        characterOrder: ['cha-a', 'cha-b', 'group-1', 'cha-empty'],
        botPresets: [{ name: 'preset 1', mainPrompt: 'x' }],
        botPresetsId: 0,
        modules: [{ id: 'mod-1', name: 'module', lorebook: [] }],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: { someKey: 'value' },
        characters: [
            makeCharacter('cha-a', [
                makeChat('chat-a1', 'First', makeMessages(10, 'a1')),
                makeChat('chat-a2', '두번째 채팅 🎉', [
                    { role: 'user', data: '안녕하세요 👋 émoji 🧪 \u0000 nul and "quotes" \\ backslash', time: 1 },
                    { role: 'char', data: '你好 🐉 😀 \n newline', time: 2 },
                ]),
                makeChat('chat-a3', 'Third', makeMessages(3, 'a3')),
            ], { chatPage: 1 }),
            makeCharacter('cha-b', [
                makeChat('chat-b1', 'Large', makeMessages(2000, 'b1')),
                makeChat('chat-b2', 'Small', makeMessages(1, 'b2')),
            ]),
            {
                type: 'group',
                chaId: 'group-1',
                name: 'Group',
                firstMessage: '',
                characters: ['cha-a', 'cha-b'],
                characterTalks: [0.6, 0.6],
                characterActive: [true, true],
                chats: [
                    makeChat('chat-g1', 'Group chat', makeMessages(5, 'g1')),
                    makeChat('chat-g2', 'Group chat 2', []),
                ],
                chatPage: 1,
                customscript: [],
                globalLore: [],
                emotionImages: [],
            },
            makeCharacter('cha-empty', []),
        ],
    }
}

function emptyToSave(extra: Partial<toSaveType> = {}): toSaveType {
    return {
        character: [],
        chat: [],
        allChats: [],
        botPreset: false,
        modules: false,
        loadouts: false,
        plugins: false,
        pluginCustomStorage: false,
        ...extra,
    }
}

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v))
}

async function makeSplitEncoder(db: any, options: { cache?: boolean, remote?: boolean } = {}) {
    const encoder = new RisuSaveEncoder({ splitChats: true, remote: options.remote ?? false, cache: options.cache ?? false })
    await encoder.init(db)
    await encoder.set(db, emptyToSave())
    return encoder
}

async function decode(file: ArrayBuffer | Uint8Array) {
    return (await new RisuSaveDecoder().decode(new Uint8Array(file))).database as any
}

function chatBlocksOf(file: ArrayBuffer | Uint8Array, chaId: string) {
    return parseBlocks(file).filter((b) => b.type === TYPE.CHAT && JSON.parse(b.content).chaId === chaId)
}

function expectNoStaleBlocks(file: ArrayBuffer | Uint8Array, db: any) {
    const blocks = parseBlocks(file)
    const names = blocks.map((b) => b.name)
    expect(new Set(names).size).toBe(names.length)
    const root = JSON.parse(blocks.find((b) => b.type === TYPE.ROOT).content)
    expect([...root.__directory].sort()).toEqual(names.filter((n) => n !== 'root').sort())
    for (const block of blocks.filter((b) => b.type === TYPE.CHAT)) {
        const payload = JSON.parse(block.content)
        const character = db.characters.find((c: any) => c.chaId === payload.chaId)
        expect(character, `chat block ${block.name} has no character`).toBeTruthy()
        const owner = blocks.find((b) => b.name === payload.chaId)
        expect(owner.type, `chat block ${block.name} belongs to a legacy character`).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expect(character.chats.some((c: any) => c.id === payload.chatId), `stale chat block ${block.name}`).toBe(true)
    }
}

beforeEach(() => {
    mocks.platform.isTauri = false
    mocks.platform.isNodeServer = false
    mocks.dbSettings = { enableRemoteSaving: false }
    mocks.cache.clear()
    mocks.forage.clear()
    mocks.fs.clear()
    mocks.dirs.clear()
    resetRemoteSaveSession()
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('split chat saving: round trip', () => {
    it('decodes a split save to the original database', async () => {
        const db = makeDatabase()
        const before = clone(db)
        const encoder = await makeSplitEncoder(db)
        const file = encoder.encode()

        expect(db).toEqual(before) //encoder never mutates the database

        const blocks = parseBlocks(file)
        const types = new Map(blocks.map((b) => [b.name, b.type]))
        for (const character of db.characters) {
            expect(types.get(character.chaId)).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
            expect(chatBlocksOf(file, character.chaId).map((b) => JSON.parse(b.content).chatId))
                .toEqual(character.chats.map((c: any) => c.id))
        }
        expect(blocks.filter((b) => b.type === TYPE.CHAT)).toHaveLength(7)
        expect(blocks.some((b) => b.type === TYPE.CHARACTER_WITH_CHAT)).toBe(false)
        expectNoStaleBlocks(file, db)

        const decoded = await decode(file)
        expect(decoded).toEqual(db)
        expect(decoded.characters.map((c: any) => c.chaId)).toEqual(['cha-a', 'cha-b', 'group-1', 'cha-empty'])
        expect(JSON.stringify(decoded)).not.toContain('__risuSplitChats')
        for (const character of decoded.characters) {
            expect(Array.isArray(character.chats)).toBe(true)
            for (const chat of character.chats) {
                expect(Object.keys(chat).sort()).toEqual(
                    Object.keys(db.characters.find((c: any) => c.chaId === character.chaId).chats.find((c: any) => c.id === chat.id)).sort()
                )
            }
        }
    })

    it('also round trips through decodeRisuSave and the init-only file', async () => {
        const db = makeDatabase()
        const encoder = new RisuSaveEncoder({ splitChats: true, remote: false, cache: false })
        await encoder.init(db)
        const decoded = (await decodeRisuSave(new Uint8Array(encoder.encode()))).database
        expect(decoded).toEqual(db)
    })

    it('round trips with compressed blocks', async () => {
        const db = makeDatabase()
        const encoder = new RisuSaveEncoder({ splitChats: true, remote: false, cache: false })
        await encoder.init(db, { compression: true })
        await encoder.set(db, emptyToSave())
        const file = encoder.encode()
        expect(parseBlocks(file).every((b) => b.compressed)).toBe(true)
        expect(await decode(file)).toEqual(db)
    })

    it('stores chats as a non-iterable marker in the character block (older clients fail instead of loading no chats)', async () => {
        const db = makeDatabase()
        const file = (await makeSplitEncoder(db)).encode()
        const character = JSON.parse(blockMap(file).get('cha-a').content)
        expect(Array.isArray(character.chats)).toBe(false)
        expect(character.chats).toEqual({ __risuSplitChats: 1, ids: ['chat-a1', 'chat-a2', 'chat-a3'] })
        expect(() => {
            for (const chat of character.chats) {
                void chat
            }
        }).toThrow(TypeError)
    })
})

describe('legacy format', () => {
    it('is unchanged by default and decodes identically', async () => {
        const db = makeDatabase()
        const legacyFile = await encodeRisuSave(db)
        const defaultEncoder = new RisuSaveEncoder({ remote: false, cache: false })
        await defaultEncoder.init(db)
        expect(new Uint8Array(defaultEncoder.encode())).toEqual(legacyFile)

        const blocks = parseBlocks(legacyFile)
        expect(blocks.some((b) => b.type === TYPE.CHAT || b.type === TYPE.CHARACTER_WITHOUT_CHAT)).toBe(false)
        expect(blocks.filter((b) => b.type === TYPE.CHARACTER_WITH_CHAT).map((b) => b.name))
            .toEqual(['cha-a', 'cha-b', 'group-1', 'cha-empty'])
        expect(await decode(legacyFile)).toEqual(db)
    })

    it('legacy incremental saves are unchanged', async () => {
        const db = makeDatabase()
        const encoder = new RisuSaveEncoder({ remote: false, cache: false })
        await encoder.init(db)
        await encoder.set(db, emptyToSave())
        db.characters[0].chats[0].message.push({ role: 'user', data: 'new', time: 3 })
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a1']] }))
        const file = encoder.encode()
        expect(parseBlocks(file).some((b) => b.type === TYPE.CHAT || b.type === TYPE.CHARACTER_WITHOUT_CHAT)).toBe(false)
        expect(await decode(file)).toEqual(db)
    })

    it('decodes a legacy CHARACTER_WITHOUT_CHAT block that holds a full character', async () => {
        const db = makeDatabase()
        const encoder = new RisuSaveEncoder({ remote: false, cache: false })
        await encoder.init(db)
        const file = encoder.encode()
        const rebuilt: Uint8Array[] = []
        for (const block of parseBlocks(file)) {
            if (block.name === 'cha-b') {
                rebuilt.push(await encoder.encodeRawBlock({
                    compression: false,
                    data: block.content,
                    type: TYPE.CHARACTER_WITHOUT_CHAT,
                    name: block.name,
                    cache: false,
                }))
            }
            else {
                rebuilt.push(block.raw)
            }
        }
        expect(await decode(assembleBlocks(rebuilt))).toEqual(db)
    })
})

describe('per-character fallback to the legacy block', () => {
    async function expectLegacyFallback(db: any, chaId: string) {
        const before = clone(db)
        const file = (await makeSplitEncoder(db)).encode()
        expect(db).toEqual(before)
        expect(blockMap(file).get(chaId).type).toBe(TYPE.CHARACTER_WITH_CHAT)
        expect(chatBlocksOf(file, chaId)).toHaveLength(0)
        //other characters are still split
        expect(blockMap(file).get('cha-b').type).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    }

    it('a chat without id', async () => {
        const db = makeDatabase()
        db.characters[0].chats.push(makeChat(undefined, 'no id', makeMessages(2)))
        await expectLegacyFallback(db, 'cha-a')
    })

    it('duplicate chat ids', async () => {
        const db = makeDatabase()
        db.characters[0].chats.push(makeChat('chat-a1', 'duplicate', makeMessages(2)))
        await expectLegacyFallback(db, 'cha-a')
    })

    it('a block name over 255 bytes', async () => {
        const db = makeDatabase()
        db.characters[0].chats[1].id = '가'.repeat(84) //252 bytes, the block name gets longer than 255
        await expectLegacyFallback(db, 'cha-a')
    })

    it('a chaId that collides with a chat block name', async () => {
        const db = makeDatabase()
        db.characters.push(makeCharacter('chat-cha-a-chat-a1', [makeChat('x-1', 'x', [])]))
        await expectLegacyFallback(db, 'cha-a')
    })

    it('chats that is not an array', async () => {
        const db = makeDatabase()
        db.characters[0].chats = { not: 'an array' }
        const file = (await makeSplitEncoder(db)).encode()
        expect(blockMap(file).get('cha-a').type).toBe(TYPE.CHARACTER_WITH_CHAT)
        expect(chatBlocksOf(file, 'cha-a')).toHaveLength(0)
        expect(await decode(file)).toEqual(db)
    })

    it('a character with ids that are not safe file names, with remote saving', async () => {
        mocks.platform.isNodeServer = true
        mocks.dbSettings.enableRemoteSaving = true
        const db = makeDatabase()
        db.characters[0].chats[1].id = 'chat a2.x'
        const encoder = new RisuSaveEncoder({ splitChats: true, cache: false })
        await encoder.init(db, { skipRemoteSavingOnCharacters: false })
        await encoder.set(db, emptyToSave())
        const file = encoder.encode()
        const remote = blockMap(file).get('cha-a')
        expect(remote.type).toBe(TYPE.REMOTE)
        expect(JSON.parse(remote.content).type).toBe(TYPE.CHARACTER_WITH_CHAT)
        expect(JSON.parse(new TextDecoder().decode(mocks.forage.get('remotes/cha-a.local.bin'))).chats).toHaveLength(3)
        expect([...mocks.forage.keys()].some((k) => k.startsWith('remotes/chat-cha-a-'))).toBe(false)
        //other characters are still split into chat files
        expect(JSON.parse(blockMap(file).get('cha-b').content).type).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expect(mocks.forage.has('remotes/chat-cha-b-chat-b1.local.bin')).toBe(true)
        expect(await decode(file)).toEqual(db)
    })

    it('a chat block name of exactly 255 bytes is split, 256 bytes is legacy', async () => {
        const db = makeDatabase()
        //'chat-' + 240 + '-' + 'chat-long' = 255 bytes
        db.characters[3].chaId = 'c'.repeat(240)
        db.characters[3].chats = [makeChat('chat-long', 'long', [])]
        let file = (await makeSplitEncoder(db)).encode()
        expect(blockMap(file).get('c'.repeat(240)).type).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expect(await decode(file)).toEqual(db)

        db.characters[3].chaId = 'c'.repeat(241)
        file = (await makeSplitEncoder(db)).encode()
        expect(blockMap(file).get('c'.repeat(241)).type).toBe(TYPE.CHARACTER_WITH_CHAT)
        expect(chatBlocksOf(file, 'c'.repeat(241))).toHaveLength(0)
        expect(await decode(file)).toEqual(db)
    })
})

describe('incremental set', () => {
    it('modifying one chat only re-encodes that chat block', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        const before = blockMap(encoder.encode())

        db.characters[0].chats[2].message.push({ role: 'user', data: 'changed', time: 9 })
        //not marked dirty: proves only the listed chat is re-encoded
        db.characters[0].chats[0].note = 'unsaved change'
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a3']] }))
        const file = encoder.encode()
        const after = blockMap(file)

        const changed = [...after.keys()].filter((name) => !before.has(name) || !equalBytes(before.get(name).raw, after.get(name).raw))
        expect(changed).toEqual(['chat-cha-a-chat-a3'])
        expect([...before.keys()]).toEqual([...after.keys()])

        const decoded = await decode(file)
        expect(decoded.characters[0].chats[2]).toEqual(db.characters[0].chats[2])
        expect(decoded.characters[0].chats[0].note).toBe('note of First')
    })

    it('a dirty character without chat information re-encodes all its chats', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        db.characters[0].chats[0].note = 'changed 1'
        db.characters[0].chats[2].note = 'changed 3'
        await encoder.set(db, emptyToSave({ character: ['cha-a'] }))
        expect(await decode(encoder.encode())).toEqual(db)
    })

    it('allChats re-encodes all chats of the character', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        db.characters[0].chats[0].note = 'changed 1'
        db.characters[0].chats[2].note = 'changed 3'
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a2']], allChats: ['cha-a'] }))
        expect(await decode(encoder.encode())).toEqual(db)
    })

    it('adding a chat creates its block even if it is not listed as dirty', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        db.characters[0].chats.push(makeChat('chat-a4', 'New', makeMessages(4, 'a4')))
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a2']] }))
        const file = encoder.encode()
        expect(blockMap(file).has('chat-cha-a-chat-a4')).toBe(true)
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    })

    it('deleting a chat removes its block and it is not resurrected from the block cache', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db, { cache: true })
        expect(mocks.cache.has('risuSaveBlock_chat-cha-a-chat-a1')).toBe(true)
        db.characters[0].chats.splice(0, 1)
        db.characters[0].chatPage = 0
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a2']] }))
        const file = encoder.encode()
        expect(blockMap(file).has('chat-cha-a-chat-a1')).toBe(false)
        expectNoStaleBlocks(file, db)
        const decoded = await decode(file)
        expect(decoded).toEqual(db)
        expect(decoded.characters[0].chats.map((c: any) => c.id)).toEqual(['chat-a2', 'chat-a3'])
    })

    it('reordering chats only changes the character block', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        const before = blockMap(encoder.encode())
        db.characters[0].chats.reverse()
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a2']] }))
        const file = encoder.encode()
        const after = blockMap(file)
        const changed = [...after.keys()].filter((name) => !equalBytes(before.get(name).raw, after.get(name).raw))
        expect(changed).toEqual(['cha-a'])
        const decoded = await decode(file)
        expect(decoded.characters[0].chats.map((c: any) => c.id)).toEqual(['chat-a3', 'chat-a2', 'chat-a1'])
        expect(decoded).toEqual(db)
    })

    it('changing chatPage is saved', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        db.characters[0].chatPage = 2
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a3']] }))
        const decoded = await decode(encoder.encode())
        expect(decoded.characters[0].chatPage).toBe(2)
        expect(decoded).toEqual(db)
    })

    it('deleting a character removes all its blocks', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        db.characters.splice(0, 1)
        await encoder.set(db, emptyToSave({ character: ['cha-a'] }))
        const file = encoder.encode()
        expect(parseBlocks(file).filter((b) => b.name.includes('cha-a'))).toHaveLength(0)
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    })

    it('switching a character between split and legacy leaves no stale blocks', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)

        //split -> legacy (chat without id)
        db.characters[0].chats.push(makeChat(undefined, 'no id', []))
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a1']] }))
        let file = encoder.encode()
        expect(blockMap(file).get('cha-a').type).toBe(TYPE.CHARACTER_WITH_CHAT)
        expect(chatBlocksOf(file, 'cha-a')).toHaveLength(0)
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)

        //legacy -> split again, with a deleted chat in between
        db.characters[0].chats[3].id = 'chat-a4'
        db.characters[0].chats.splice(0, 1)
        db.characters[0].chatPage = 0
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a2']] }))
        file = encoder.encode()
        expect(blockMap(file).get('cha-a').type).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expect(chatBlocksOf(file, 'cha-a').map((b) => b.name)).toEqual(['chat-cha-a-chat-a2', 'chat-cha-a-chat-a3', 'chat-cha-a-chat-a4'])
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)

        //the character block keeps its position (character order)
        expect(parseBlocks(file).filter((b) => b.type === TYPE.CHARACTER_WITHOUT_CHAT).map((b) => b.name))
            .toEqual(['cha-a', 'cha-b', 'group-1', 'cha-empty'])
    })

    it('toggling the option (full encoder reload) leaves no stale blocks', async () => {
        const db = makeDatabase()
        const split = await makeSplitEncoder(db)
        expect(parseBlocks(split.encode()).some((b) => b.type === TYPE.CHAT)).toBe(true)

        const legacy = new RisuSaveEncoder({ splitChats: false, remote: false, cache: false })
        await legacy.init(db)
        await legacy.set(db, emptyToSave())
        const legacyFile = legacy.encode()
        expect(parseBlocks(legacyFile).some((b) => b.type === TYPE.CHAT || b.type === TYPE.CHARACTER_WITHOUT_CHAT)).toBe(false)
        expectNoStaleBlocks(legacyFile, db)
        expect(await decode(legacyFile)).toEqual(db)

        const splitAgain = await makeSplitEncoder(db)
        const file = splitAgain.encode()
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    })

    it('toggling remote saving inside one encoder keeps the save readable', async () => {
        mocks.platform.isNodeServer = true
        mocks.dbSettings.enableRemoteSaving = true
        const db = makeDatabase()
        const encoder = new RisuSaveEncoder({ splitChats: true, cache: false })
        await encoder.init(db, { skipRemoteSavingOnCharacters: false })
        await encoder.set(db, emptyToSave())
        mocks.dbSettings.enableRemoteSaving = false
        db.characters[0].chats[0].note = 'after remote'
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a1']] }))
        const file = encoder.encode()
        expect(blockMap(file).get('cha-a').type).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expect(blockMap(file).get('chat-cha-a-chat-a1').type).toBe(TYPE.CHAT)
        //unchanged chats keep their remote blocks until the next full reload (saveDb reloads on toggles)
        expect(blockMap(file).get('chat-cha-a-chat-a2').type).toBe(TYPE.REMOTE)
        expect(blockMap(file).get('cha-b').type).toBe(TYPE.REMOTE)
        expect(await decode(file)).toEqual(db)

        mocks.dbSettings.enableRemoteSaving = true
        db.characters[0].chats[0].note = 'remote again'
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a1']] }))
        const file2 = encoder.encode()
        expect(blockMap(file2).get('cha-a').type).toBe(TYPE.REMOTE)
        expect(blockMap(file2).get('chat-cha-a-chat-a1').type).toBe(TYPE.REMOTE)
        expect(await decode(file2)).toEqual(db)
    })

    it('a failing encode leaves the previous blocks in place', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        const before = encoder.encode()
        db.characters[0].chats[0].note = 'changed'
        const spy = vi.spyOn(encoder, 'encodeRawBlock').mockRejectedValueOnce(new Error('boom'))
        await expect(encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a1']] }))).rejects.toThrow('boom')
        spy.mockRestore()
        expect(new Uint8Array(encoder.encode())).toEqual(new Uint8Array(before))
    })
})

describe('deleting characters without listing them', () => {
    function changedBlocks(before: Map<string, ParsedBlock>, after: Map<string, ParsedBlock>) {
        return [...after.keys()].filter((name) => !before.has(name) || !equalBytes(before.get(name).raw, after.get(name).raw))
    }

    function expectNoTrace(file: ArrayBuffer | Uint8Array, chaId: string) {
        const blocks = parseBlocks(file)
        expect(blocks.some((b) => b.name === chaId)).toBe(false)
        expect(blocks.some((b) => b.type === TYPE.CHAT && JSON.parse(b.content).chaId === chaId)).toBe(false)
        expect(blocks.some((b) => b.name.startsWith(`chat-${chaId}-`))).toBe(false)
        const root = JSON.parse(blocks.find((b) => b.type === TYPE.ROOT).content)
        expect(root.__directory.some((n: string) => n === chaId || n.startsWith(`chat-${chaId}-`))).toBe(false)
    }

    it.each([['legacy', false], ['split', true]])('%s: a deleted character that is not dirty is removed', async (_, splitChats) => {
        const db = makeDatabase()
        const encoder = new RisuSaveEncoder({ splitChats, remote: false, cache: false })
        await encoder.init(db)
        await encoder.set(db, emptyToSave({ character: ['cha-b'], chat: [['cha-b', 'chat-b1']] }))
        const before = blockMap(encoder.encode())

        db.characters.splice(0, 1)
        //only the (unchanged) current character is listed, as saveDb does
        await encoder.set(db, emptyToSave({ character: ['cha-b'], chat: [['cha-b', 'chat-b1']] }))
        const file = encoder.encode()
        expectNoTrace(file, 'cha-a')
        expectNoStaleBlocks(file, db)
        //nothing else changed (database.bin of other characters is byte for byte the same)
        expect(changedBlocks(before, blockMap(file)).filter((n) => n !== 'root')).toEqual([])
        const decoded = await decode(file)
        expect(decoded).toEqual(db)
    })

    it('removes a deleted character with no tracker entries at all, and keeps the reserved blocks', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        db.characters.splice(1, 2)
        await encoder.set(db, emptyToSave())
        const file = encoder.encode()
        expectNoTrace(file, 'cha-b')
        expectNoTrace(file, 'group-1')
        const names = parseBlocks(file).map((b) => b.name)
        for (const name of ['root', 'preset', 'modules', 'loadouts', 'plugins', 'pluginStorage', 'config']) {
            expect(names).toContain(name)
        }
        expect(await decode(file)).toEqual(db)
    })

    it('a character with a reserved chaId never drops the reserved block', async () => {
        const db = makeDatabase()
        db.characters.push(makeCharacter('config', []))
        const encoder = await makeSplitEncoder(db)
        db.characters.pop()
        await encoder.set(db, emptyToSave())
        expect(encoder.encode()).not.toBeNull()
    })

    it('a chaId that is not duplicated anymore is encoded again', async () => {
        const db = makeDatabase()
        db.characters.push(makeCharacter('cha-a', [makeChat('dup-1', 'dup', [])], { name: 'duplicate' }))
        const encoder = await makeSplitEncoder(db)
        //the shared legacy block holds the duplicate (encoded last)
        expect(JSON.parse(blockMap(encoder.encode()).get('cha-a').content).name).toBe('duplicate')
        db.characters.pop()
        await encoder.set(db, emptyToSave())
        const file = encoder.encode()
        expect(blockMap(file).get('cha-a').type).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    })

    it('a character re-added with the same chaId is encoded again', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        const removed = db.characters.splice(0, 1)[0]
        await encoder.set(db, emptyToSave())
        db.characters.push(removed)
        await encoder.set(db, emptyToSave())
        const file = encoder.encode()
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    })
})

describe('character-only dirty', () => {
    it('split: re-encodes only the character block', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        const before = blockMap(encoder.encode())
        db.characters[0].trashTime = 1234
        //not saved: proves the chats are not re-encoded
        db.characters[0].chats[0].note = 'unsaved'
        await encoder.set(db, emptyToSave({ characterOnly: ['cha-a'] }))
        const file = encoder.encode()
        const after = blockMap(file)
        const changed = [...after.keys()].filter((name) => !equalBytes(before.get(name).raw, after.get(name).raw))
        //the root block does not change either (it only lists the block names)
        expect(changed).toEqual(['cha-a'])
        const decoded = await decode(file)
        expect(decoded.characters[0].trashTime).toBe(1234)
        expect(decoded.characters[0].chats[0].note).toBe('note of First')
        db.characters[0].chats[0].note = 'note of First'
        expect(decoded).toEqual(db)
    })

    it('split: still encodes chats that have no block yet', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        db.characters[1].chats.push(makeChat('chat-b3', 'new', makeMessages(2, 'b3')))
        await encoder.set(db, emptyToSave({ characterOnly: ['cha-b'] }))
        const file = encoder.encode()
        expect(blockMap(file).has('chat-cha-b-chat-b3')).toBe(true)
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    })

    it('legacy: rewrites the whole character block', async () => {
        const db = makeDatabase()
        const encoder = new RisuSaveEncoder({ remote: false, cache: false })
        await encoder.init(db)
        db.characters[1].trashTime = 99
        db.characters[1].chats[0].note = 'saved too'
        await encoder.set(db, emptyToSave({ characterOnly: ['cha-b'] }))
        expect(await decode(encoder.encode())).toEqual(db)
    })

    it('a chaId also listed in character follows the character rules (all chats without chat information)', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        db.characters[0].chats[2].note = 'changed'
        await encoder.set(db, emptyToSave({ character: ['cha-a'], characterOnly: ['cha-a'] }))
        expect(await decode(encoder.encode())).toEqual(db)
    })

    it('ignores a chaId that is not in the database', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        await encoder.set(db, emptyToSave({ characterOnly: ['nobody'] }))
        expect(await decode(encoder.encode())).toEqual(db)
    })
})

describe('chaId / chat block name collisions with deleted characters', () => {
    const colliding = 'chat-cha-a-chat-a1'

    it('deleting the colliding character lets the owner split again, without a trace of it', async () => {
        const db = makeDatabase()
        db.characters.push(makeCharacter(colliding, [makeChat('x-1', 'x', [])]))
        const encoder = await makeSplitEncoder(db)
        expect(blockMap(encoder.encode()).get('cha-a').type).toBe(TYPE.CHARACTER_WITH_CHAT)
        db.characters.pop()
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a2']] }))
        const file = encoder.encode()
        const block = blockMap(file).get(colliding)
        //the name is now cha-a's chat block
        expect(block.type).toBe(TYPE.CHAT)
        expect(JSON.parse(block.content).chaId).toBe('cha-a')
        expect(parseBlocks(file).some((b) => b.name === `chat-${colliding}-x-1`)).toBe(false)
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    })

    it('deleting the colliding character without listing anything keeps the owner valid', async () => {
        const db = makeDatabase()
        db.characters.push(makeCharacter(colliding, [makeChat('x-1', 'x', [])]))
        const encoder = await makeSplitEncoder(db)
        db.characters.pop()
        await encoder.set(db, emptyToSave())
        const file = encoder.encode()
        expect(blockMap(file).has(colliding)).toBe(false)
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    })

    it('adding a colliding character releases the chat block, then deleting the owner removes the rest', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        expect(blockMap(encoder.encode()).get(colliding).type).toBe(TYPE.CHAT)
        db.characters.push(makeCharacter(colliding, [makeChat('x-1', 'x', [])]))
        await encoder.set(db, emptyToSave())
        let file = encoder.encode()
        expect(blockMap(file).get(colliding).type).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expect(blockMap(file).get('cha-a').type).toBe(TYPE.CHARACTER_WITH_CHAT)
        expect(await decode(file)).toEqual(db)

        db.characters.splice(0, 1)
        await encoder.set(db, emptyToSave())
        file = encoder.encode()
        expect(blockMap(file).has('cha-a')).toBe(false)
        expect(blockMap(file).get(colliding).type).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    })

    it('the owner is deleted in the same save that adds the colliding character', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        db.characters.splice(0, 1)
        db.characters.push(makeCharacter(colliding, [makeChat('x-1', 'x', [])]))
        await encoder.set(db, emptyToSave())
        const file = encoder.encode()
        expect(blockMap(file).get(colliding).type).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expect(blockMap(file).has('cha-a')).toBe(false)
        expect(parseBlocks(file).filter((b) => b.name.startsWith('chat-cha-a-')).map((b) => b.name)).toEqual([colliding])
        expect(chatBlocksOf(file, 'cha-a')).toHaveLength(0)
        expectNoStaleBlocks(file, db)
        expect(await decode(file)).toEqual(db)
    })
})

describe('decoder robustness', () => {
    it('inserts a placeholder for a missing chat block', async () => {
        const db = makeDatabase()
        const file = (await makeSplitEncoder(db)).encode()
        const kept = parseBlocks(file).filter((b) => b.name !== 'chat-cha-a-chat-a2').map((b) => b.raw)
        const decoded = await decode(assembleBlocks(kept))
        const chats = decoded.characters[0].chats
        expect(chats.map((c: any) => c.id)).toEqual(['chat-a1', 'chat-a2', 'chat-a3'])
        expect(chats[1].message).toHaveLength(1)
        expect(chats[1].message[0].data).toContain('could not be loaded')
        expect(chats[1].message[0].data).toContain('chat-a2')
        expect(decoded.characters[0].chatPage).toBe(1)
        expect(chats[0]).toEqual(db.characters[0].chats[0])
    })

    it('loads a missing chat block from the block cache when the directory lists it', async () => {
        const db = makeDatabase()
        const file = (await makeSplitEncoder(db, { cache: true })).encode()
        const kept = parseBlocks(file).filter((b) => b.name !== 'chat-cha-b-chat-b1').map((b) => b.raw)
        expect(await decode(assembleBlocks(kept))).toEqual(db)
    })

    it('appends a chat block that is not in the order list of an existing character', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        const orphan = makeChat('chat-orphan', 'orphan', makeMessages(2))
        const extra = await encoder.encodeRawBlock({
            compression: false,
            data: JSON.stringify({ v: 1, chaId: 'cha-b', chatId: 'chat-orphan', chat: orphan }),
            type: TYPE.CHAT,
            name: 'some-other-name',
            cache: false,
        })
        const decoded = await decode(assembleBlocks([...parseBlocks(encoder.encode()).map((b) => b.raw), extra]))
        expect(decoded.characters[1].chats.map((c: any) => c.id)).toEqual(['chat-b1', 'chat-b2', 'chat-orphan'])
        expect(decoded.characters[1].chats[2]).toEqual(orphan)
    })

    it('drops a chat block whose character does not exist', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        const extra = await encoder.encodeRawBlock({
            compression: false,
            data: JSON.stringify({ v: 1, chaId: 'nobody', chatId: 'chat-x', chat: makeChat('chat-x', 'x', []) }),
            type: TYPE.CHAT,
            name: 'chat-nobody-chat-x',
            cache: false,
        })
        const decoded = await decode(assembleBlocks([...parseBlocks(encoder.encode()).map((b) => b.raw), extra]))
        expect(decoded).toEqual(db)
        expect(warn.mock.calls.some((args) => String(args[0]).includes('does not exist'))).toBe(true)
    })

    it('ignores an invalid chat block', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        const extra = await encoder.encodeRawBlock({
            compression: false,
            data: JSON.stringify({ chaId: 'cha-a' }),
            type: TYPE.CHAT,
            name: 'broken',
            cache: false,
        })
        const decoded = await decode(assembleBlocks([...parseBlocks(encoder.encode()).map((b) => b.raw), extra]))
        expect(decoded).toEqual(db)
    })

    it('decodes a split character stored in a remote block', async () => {
        const db = makeDatabase()
        const encoder = await makeSplitEncoder(db)
        const blocks = parseBlocks(encoder.encode())
        const characterBlock = blocks.find((b) => b.name === 'cha-a')
        mocks.forage.set('remotes/cha-a.local.bin', new TextEncoder().encode(characterBlock.content))
        const remote = await encoder.encodeRawBlock({
            compression: false,
            data: JSON.stringify({ v: 1, type: TYPE.CHARACTER_WITHOUT_CHAT, name: 'cha-a' }),
            type: TYPE.REMOTE,
            name: 'cha-a',
            cache: false,
        })
        const decoded = await decode(assembleBlocks(blocks.map((b) => b.name === 'cha-a' ? remote : b.raw)))
        //remote blocks are processed after the in-file blocks, so the character moves to the end (as before)
        const character = decoded.characters.find((c: any) => c.chaId === 'cha-a')
        expect(character).toEqual(db.characters[0])
        expect(decoded.characters).toHaveLength(4)
    })

    it('keeps chatPage valid when the stored page is out of range', async () => {
        const db = makeDatabase()
        db.characters[1].chatPage = 7
        const decoded = await decode((await makeSplitEncoder(db)).encode())
        expect(decoded.characters[1].chatPage).toBe(0)
    })
})

type Platform = 'tauri' | 'node'

/** remote files of the current platform, by `remotes/...` path */
function remoteFiles(platform: Platform): Map<string, any> {
    return platform === 'tauri' ? mocks.fs : mocks.forage
}

function readRemote(platform: Platform, path: string) {
    const data = remoteFiles(platform).get(path)
    return data === undefined ? undefined : new TextDecoder().decode(data)
}

function remotePaths(platform: Platform) {
    return [...remoteFiles(platform).keys()].filter((k) => k.startsWith('remotes/')).sort()
}

/** paths of the remote files written by `run` (final paths, temp files and renames excluded) */
async function writtenDuring(platform: Platform, run: () => Promise<void>) {
    const written: string[] = []
    if (platform === 'tauri') {
        const rename = vi.mocked(tauriFs.rename)
        const before = rename.mock.calls.length
        const writes = vi.mocked(tauriFs.writeFile).mock.calls.length
        await run()
        for (const [, to] of rename.mock.calls.slice(before)) {
            if (String(to).endsWith('.local.bin')) {
                written.push(String(to))
            }
        }
        for (const [path] of vi.mocked(tauriFs.writeFile).mock.calls.slice(writes)) {
            if (String(path).endsWith('.local.bin')) {
                written.push(String(path))
            }
        }
        return written.sort()
    }
    const original = forageStorage.setItem
    const spy = vi.spyOn(forageStorage, 'setItem').mockImplementation(async (key: string, value: any) => {
        if (key.endsWith('.local.bin')) {
            written.push(key)
        }
        return original(key, value)
    })
    await run()
    spy.mockRestore()
    return written.sort()
}

async function makeRemoteSplitEncoder(db: any) {
    const encoder = new RisuSaveEncoder({ splitChats: true, cache: false })
    await encoder.init(db, { skipRemoteSavingOnCharacters: false })
    await encoder.set(db, emptyToSave())
    return encoder
}

/** a second app session: the per-session backup state is forgotten */
function restartApp() {
    resetRemoteSaveSession()
}

describe.each<[Platform]>([['tauri'], ['node']])('remote split saving (%s)', (platform) => {
    beforeEach(() => {
        mocks.platform.isTauri = platform === 'tauri'
        mocks.platform.isNodeServer = platform === 'node'
        mocks.dbSettings.enableRemoteSaving = true
    })

    const chatFile = (chaId: string, chatId: string) => `remotes/chat-${chaId}-${chatId}.local.bin`

    it('writes one file per chat and decodes everything in order', async () => {
        const db = makeDatabase()
        const encoder = await makeRemoteSplitEncoder(db)
        const file = encoder.encode()

        const blocks = parseBlocks(file)
        for (const character of db.characters) {
            const pointer = JSON.parse(blockMap(file).get(character.chaId).content)
            expect(blockMap(file).get(character.chaId).type).toBe(TYPE.REMOTE)
            expect(pointer).toEqual({ v: 1, type: TYPE.CHARACTER_WITHOUT_CHAT, name: character.chaId })
            const stored = JSON.parse(readRemote(platform, `remotes/${character.chaId}.local.bin`))
            expect(stored.chats).toEqual({ __risuSplitChats: 1, ids: character.chats.map((c: any) => c.id) })
            for (const chat of character.chats) {
                const name = `chat-${character.chaId}-${chat.id}`
                expect(blockMap(file).get(name).type).toBe(TYPE.REMOTE)
                expect(JSON.parse(blockMap(file).get(name).content).type).toBe(TYPE.CHAT)
                expect(JSON.parse(readRemote(platform, chatFile(character.chaId, chat.id)))).toEqual({
                    v: 1, chaId: character.chaId, chatId: chat.id, chat,
                })
            }
        }
        expect(blocks.some((b) => b.type === TYPE.CHAT || b.type === TYPE.CHARACTER_WITHOUT_CHAT || b.type === TYPE.CHARACTER_WITH_CHAT)).toBe(false)
        //nothing existed before: no backups, and no temp files are left
        expect(remotePaths(platform).every((p) => p.endsWith('.local.bin'))).toBe(true)
        expect(remotePaths(platform)).toHaveLength(4 + 7)

        const decoded = await decode(file)
        expect(decoded).toEqual(db)
        expect(decoded.characters.map((c: any) => c.chaId)).toEqual(['cha-a', 'cha-b', 'group-1', 'cha-empty'])
        expect(decoded.characters[0].chats.map((c: any) => c.id)).toEqual(['chat-a1', 'chat-a2', 'chat-a3'])
    })

    it('editing one chat writes only that chat file', async () => {
        const db = makeDatabase()
        const encoder = await makeRemoteSplitEncoder(db)
        const before = encoder.encode()

        db.characters[1].chats[0].message.push({ role: 'char', data: 'streaming...', time: 5 })
        const written = await writtenDuring(platform, () =>
            encoder.set(db, emptyToSave({ character: ['cha-b'], chat: [['cha-b', 'chat-b1']] })))
        expect(written).toEqual([chatFile('cha-b', 'chat-b1')])
        const file = encoder.encode()
        //database.bin only holds pointers: it does not change
        expect(parseBlocks(file).filter((b) => b.name !== 'root').map((b) => b.raw))
            .toEqual(parseBlocks(before).filter((b) => b.name !== 'root').map((b) => b.raw))
        expect(await decode(file)).toEqual(db)

        //a change of the character itself rewrites its (small) file too
        db.characters[1].chatPage = 1
        db.characters[1].chats[0].note = 'edited'
        const written2 = await writtenDuring(platform, () =>
            encoder.set(db, emptyToSave({ character: ['cha-b'], chat: [['cha-b', 'chat-b1']] })))
        expect(written2).toEqual(['remotes/cha-b.local.bin', chatFile('cha-b', 'chat-b1')])
        expect(await decode(encoder.encode())).toEqual(db)
    })

    it('adds and deletes chat files with the chat list', async () => {
        const db = makeDatabase()
        const encoder = await makeRemoteSplitEncoder(db)
        db.characters[0].chats.splice(0, 1)
        db.characters[0].chatPage = 0
        db.characters[0].chats.push(makeChat('chat-a4', 'new', makeMessages(2, 'a4')))
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a2']] }))
        const file = encoder.encode()
        expect(blockMap(file).has('chat-cha-a-chat-a1')).toBe(false)
        expect(remoteFiles(platform).has(chatFile('cha-a', 'chat-a4'))).toBe(true)
        expect(await decode(file)).toEqual(db)
    })

    it('falls back to a single legacy remote block for unsafe ids', async () => {
        const db = makeDatabase()
        db.characters[0].chats[2].id = 'chat:a3'
        db.characters[1].chaId = 'cha b'
        const file = (await makeRemoteSplitEncoder(db)).encode()
        for (const chaId of ['cha-a', 'cha b']) {
            expect(JSON.parse(blockMap(file).get(chaId).content).type).toBe(TYPE.CHARACTER_WITH_CHAT)
            expect(Array.isArray(JSON.parse(readRemote(platform, `remotes/${chaId}.local.bin`)).chats)).toBe(true)
        }
        expect(remotePaths(platform).some((p) => p.startsWith('remotes/chat-cha-a-') || p.startsWith('remotes/chat-cha b'))).toBe(false)
        expect(JSON.parse(blockMap(file).get('group-1').content).type).toBe(TYPE.CHARACTER_WITHOUT_CHAT)
        expect(await decode(file)).toEqual(db)
    })

    it('limits the chat file name length (stricter on the Node server, which hex encodes file names)', async () => {
        const db = makeDatabase()
        db.characters[3].chaId = 'c'.repeat(60)
        db.characters[3].chats = [makeChat('d'.repeat(30), 'x', [])] //name: 5 + 60 + 1 + 30 = 96 bytes
        db.characters.push(makeCharacter('e'.repeat(120), [makeChat('f'.repeat(80), 'y', [])])) //206 bytes
        const file = (await makeRemoteSplitEncoder(db)).encode()
        expect(JSON.parse(blockMap(file).get('c'.repeat(60)).content).type)
            .toBe(platform === 'tauri' ? TYPE.CHARACTER_WITHOUT_CHAT : TYPE.CHARACTER_WITH_CHAT)
        expect(JSON.parse(blockMap(file).get('e'.repeat(120)).content).type).toBe(TYPE.CHARACTER_WITH_CHAT)
        expect(await decode(file)).toEqual(db)
    })

    it('keeps the version from before the session as .bak on the first overwrite only', async () => {
        const db = makeDatabase()
        await makeRemoteSplitEncoder(db)
        const firstSession = readRemote(platform, chatFile('cha-a', 'chat-a1'))
        //the first session created the files: nothing to back up
        expect(remotePaths(platform).some((p) => p.endsWith('.bak'))).toBe(false)

        restartApp()
        //changed while the app was closed (e.g. a migration): the init write is the first overwrite
        db.characters[0].chats[0].note = 'second session 0'
        const encoder = await makeRemoteSplitEncoder(db)
        expect(readRemote(platform, chatFile('cha-a', 'chat-a1') + '.bak')).toBe(firstSession)
        db.characters[0].chats[0].note = 'second session 1'
        db.characters[0].name = 'renamed'
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a1']] }))
        expect(readRemote(platform, chatFile('cha-a', 'chat-a1') + '.bak')).toBe(firstSession)
        db.characters[0].chats[0].note = 'second session 2'
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a1']] }))
        expect(readRemote(platform, chatFile('cha-a', 'chat-a1') + '.bak')).toBe(firstSession)
        expect(JSON.parse(readRemote(platform, chatFile('cha-a', 'chat-a1'))).chat.note).toBe('second session 2')
        //character files never get a backup
        expect(remoteFiles(platform).has('remotes/cha-a.local.bin.bak')).toBe(false)
        expect(remotePaths(platform).some((p) => p.includes('.tmp') || p.includes('.corrupt-'))).toBe(false)
        expect(await decode(encoder.encode())).toEqual(db)
    })

    it('moves a corrupt previous version to .corrupt-* and leaves the existing .bak alone', async () => {
        const db = makeDatabase()
        await makeRemoteSplitEncoder(db)
        const path = chatFile('cha-a', 'chat-a2')
        const goodBackup = new TextEncoder().encode(JSON.stringify({ v: 1, chaId: 'cha-a', chatId: 'chat-a2', chat: { id: 'chat-a2', old: true } }))
        remoteFiles(platform).set(path + '.bak', goodBackup)
        remoteFiles(platform).set(path, new TextEncoder().encode('{"v":1,"cha'))

        restartApp()
        const encoder = await makeRemoteSplitEncoder(db)
        db.characters[0].chats[1].note = 'new'
        await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a2']] }))
        const corrupt = remotePaths(platform).filter((p) => p.startsWith(path + '.corrupt-'))
        expect(corrupt).toHaveLength(1)
        expect(corrupt[0]).toMatch(/\.corrupt-\d+$/)
        expect(readRemote(platform, corrupt[0])).toBe('{"v":1,"cha')
        expect(new Uint8Array(remoteFiles(platform).get(path + '.bak'))).toEqual(goodBackup)
        expect(JSON.parse(readRemote(platform, path)).chat.note).toBe('new')
    })

    describe('decoder', () => {
        async function twoVersions() {
            const db = makeDatabase()
            await makeRemoteSplitEncoder(db)
            const oldChat = clone(db.characters[0].chats[0])
            restartApp()
            const encoder = await makeRemoteSplitEncoder(db)
            db.characters[0].chats[0].note = 'newer'
            await encoder.set(db, emptyToSave({ character: ['cha-a'], chat: [['cha-a', 'chat-a1']] }))
            return { db, oldChat, file: encoder.encode() }
        }

        it('uses .bak when the chat file is missing', async () => {
            const { db, oldChat, file } = await twoVersions()
            remoteFiles(platform).delete(chatFile('cha-a', 'chat-a1'))
            const decoded = await decode(file)
            expect(decoded.characters[0].chats[0]).toEqual(oldChat)
            expect(decoded.characters[1]).toEqual(db.characters[1])
        })

        it('uses .bak when the chat file does not parse', async () => {
            const { oldChat, file } = await twoVersions()
            remoteFiles(platform).set(chatFile('cha-a', 'chat-a1'), new TextEncoder().encode('{broken'))
            const writes = vi.mocked(tauriFs.writeFile).mock.calls.length
            const renames = vi.mocked(tauriFs.rename).mock.calls.length
            const setItem = vi.spyOn(forageStorage, 'setItem')
            const decoded = await decode(file)
            expect(decoded.characters[0].chats[0]).toEqual(oldChat)
            //the decoder never writes
            expect(vi.mocked(tauriFs.writeFile).mock.calls.length).toBe(writes)
            expect(vi.mocked(tauriFs.rename).mock.calls.length).toBe(renames)
            expect(setItem).not.toHaveBeenCalled()
            expect(readRemote(platform, chatFile('cha-a', 'chat-a1'))).toBe('{broken')
        })

        it('inserts a placeholder when the chat file and its .bak are missing', async () => {
            const { db, file } = await twoVersions()
            remoteFiles(platform).delete(chatFile('cha-a', 'chat-a1'))
            remoteFiles(platform).delete(chatFile('cha-a', 'chat-a1') + '.bak')
            const decoded = await decode(file)
            expect(decoded.characters[0].chats.map((c: any) => c.id)).toEqual(['chat-a1', 'chat-a2', 'chat-a3'])
            expect(decoded.characters[0].chats[0].message[0].data).toContain('could not be loaded')
            expect(decoded.characters[0].chats[1]).toEqual(db.characters[0].chats[1])
        })

        it('reads the split marker behind an old CHARACTER_WITH_CHAT pointer', async () => {
            const db = makeDatabase()
            const encoder = await makeRemoteSplitEncoder(db)
            const pointer = await encoder.encodeRawBlock({
                compression: false,
                data: JSON.stringify({ v: 1, type: TYPE.CHARACTER_WITH_CHAT, name: 'cha-a' }),
                type: TYPE.REMOTE,
                name: 'cha-a',
                cache: false,
            })
            //the pointer of chat-a2 is missing too: only a character read as split finds it (in its place)
            const blocks = parseBlocks(encoder.encode()).filter((b) => b.name !== 'chat-cha-a-chat-a2')
            const decoded = await decode(assembleBlocks(blocks.map((b) => b.name === 'cha-a' ? pointer : b.raw)))
            expect(decoded).toEqual(db)
        })

        it('probes for listed chats that have no pointer in database.bin', async () => {
            const db = makeDatabase()
            const encoder = await makeRemoteSplitEncoder(db)
            //database.bin written before the new chat's pointer was added (crash after writing the files)
            const kept = parseBlocks(encoder.encode())
                .filter((b) => b.name !== 'chat-cha-a-chat-a2' && b.name !== 'chat-cha-b-chat-b1')
                .map((b) => b.raw)
            //a file of another chat with an ambiguous name is not accepted for this one
            remoteFiles(platform).set(chatFile('cha-b', 'chat-b1'), new TextEncoder().encode(JSON.stringify({
                v: 1, chaId: 'cha', chatId: 'b-chat-b1', chat: makeChat('b-chat-b1', 'other', []),
            })))
            vi.spyOn(console, 'warn').mockImplementation(() => {})
            vi.spyOn(console, 'error').mockImplementation(() => {})
            const decoded = await decode(assembleBlocks(kept))
            expect(decoded.characters[0]).toEqual(db.characters[0])
            expect(decoded.characters[1].chats[0].message[0].data).toContain('could not be loaded')
            expect(decoded.characters[1].chats[1]).toEqual(db.characters[1].chats[1])
        })

        it('keeps block order with many concurrent remote reads', async () => {
            const db = makeDatabase()
            for (let i = 0; i < 40; i++) {
                db.characters.push(makeCharacter(`many-${i}`, [makeChat(`c${i}`, `chat ${i}`, makeMessages(2, `m${i}`))]))
            }
            const file = (await makeRemoteSplitEncoder(db)).encode()
            //earlier reads finish later
            let delay = 200
            let active = 0
            let maxActive = 0
            const slow = async <T>(read: () => Promise<T>) => {
                active++
                maxActive = Math.max(maxActive, active)
                await new Promise((r) => setTimeout(r, (delay--) % 20))
                active--
                return read()
            }
            if (platform === 'tauri') {
                const read = vi.mocked(tauriFs.readFile).getMockImplementation()
                vi.mocked(tauriFs.readFile).mockImplementation((path: any) => slow(() => read(path)))
                try {
                    expect(await decode(file)).toEqual(db)
                } finally {
                    vi.mocked(tauriFs.readFile).mockImplementation(read)
                }
            }
            else {
                const getItem = forageStorage.getItem
                vi.spyOn(forageStorage, 'getItem').mockImplementation((key: string) => slow(() => getItem(key)))
                expect(await decode(file)).toEqual(db)
            }
            expect(maxActive).toBeGreaterThan(1)
            expect(maxActive).toBeLessThanOrEqual(16)
        })
    })

    it('deleting a character that is not dirty removes its pointers and writes no file', async () => {
        const db = makeDatabase()
        const encoder = await makeRemoteSplitEncoder(db)
        const filesBefore = remotePaths(platform)
        db.characters.splice(0, 1)
        const written = await writtenDuring(platform, () =>
            encoder.set(db, emptyToSave({ character: ['cha-b'], chat: [['cha-b', 'chat-b1']] })))
        //only the current chat (always dirty) is written; the other characters' files are not rewritten
        expect(written).toEqual([chatFile('cha-b', 'chat-b1')])
        const file = encoder.encode()
        expect(parseBlocks(file).some((b) => b.name === 'cha-a' || b.name.startsWith('chat-cha-a-'))).toBe(false)
        //remote files are left on disk (startup cleanup removes them later)
        expect(remotePaths(platform).filter((p) => !p.endsWith('.bak'))).toEqual(filesBefore)
        const decoded = await decode(file)
        expect(decoded).toEqual(db)
        expect(decoded.characters.some((c: any) => c.chaId === 'cha-a')).toBe(false)
    })

    it('a character-only change writes the character file and no chat file', async () => {
        const db = makeDatabase()
        const encoder = await makeRemoteSplitEncoder(db)
        db.characters[0].trashTime = 4321
        const written = await writtenDuring(platform, () =>
            encoder.set(db, emptyToSave({ characterOnly: ['cha-a'] })))
        expect(written).toEqual(['remotes/cha-a.local.bin'])
        expect(JSON.parse(readRemote(platform, 'remotes/cha-a.local.bin')).trashTime).toBe(4321)
        const decoded = await decode(encoder.encode())
        expect(decoded.characters[0].trashTime).toBe(4321)
        expect(decoded).toEqual(db)

        //unchanged again: nothing is written
        const written2 = await writtenDuring(platform, () =>
            encoder.set(db, emptyToSave({ characterOnly: ['cha-a'] })))
        expect(written2).toEqual([])
    })

    it('turning split chats off saves legacy remote characters that decode fully', async () => {
        const db = makeDatabase()
        await makeRemoteSplitEncoder(db)
        const legacy = new RisuSaveEncoder({ splitChats: false, cache: false })
        await legacy.init(db, { skipRemoteSavingOnCharacters: false })
        await legacy.set(db, emptyToSave())
        const file = legacy.encode()
        for (const character of db.characters) {
            expect(JSON.parse(blockMap(file).get(character.chaId).content).type).toBe(TYPE.CHARACTER_WITH_CHAT)
            expect(JSON.parse(readRemote(platform, `remotes/${character.chaId}.local.bin`)).chats).toEqual(character.chats)
        }
        expect(parseBlocks(file).some((b) => b.name.startsWith('chat-'))).toBe(false)
        expect(await decode(file)).toEqual(db)
    })

    it('reports the files this session writes, so startup cleanup leaves their temp files alone', async () => {
        expect(isRemoteSaveFileInUse('chat-cha-a-chat-a1.local.bin.tmp')).toBe(false)
        await makeRemoteSplitEncoder(makeDatabase())
        expect(isRemoteSaveFileInUse('chat-cha-a-chat-a1.local.bin.tmp')).toBe(true)
        expect(isRemoteSaveFileInUse('cha-a.local.bin.tmp')).toBe(true)
        expect(isRemoteSaveFileInUse('chat-gone-x.local.bin.tmp')).toBe(false)
    })

    it('lists the existing remote files once per init, and skips files that exist', async () => {
        const db = makeDatabase()
        await makeRemoteSplitEncoder(db)
        restartApp()
        vi.clearAllMocks()
        const encoder = new RisuSaveEncoder({ splitChats: true, cache: false })
        const written = await writtenDuring(platform, () => encoder.init(db))
        expect(written).toEqual([])
        if (platform === 'tauri') {
            expect(vi.mocked(tauriFs.readDir)).toHaveBeenCalledTimes(1)
            //only the folder itself is checked, not each file
            expect(vi.mocked(tauriFs.exists).mock.calls.every(([path]) => path === 'remotes')).toBe(true)
        }
        else {
            expect(vi.mocked(forageStorage.keys)).toHaveBeenCalledTimes(1)
        }
        await encoder.set(db, emptyToSave())
        expect(await decode(encoder.encode())).toEqual(db)
    })
})

function equalBytes(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) {
        return false
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false
        }
    }
    return true
}
