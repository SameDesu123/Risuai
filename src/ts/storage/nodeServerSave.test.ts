import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./database.svelte', () => ({
    getDatabase: () => ({}),
    presetTemplate: { name: 'Default' },
}))
vi.mock('../globalApi.svelte', () => ({
    forageStorage: {},
}))
vi.mock('src/ts/platform', () => ({
    isTauri: false,
    isNodeServer: true,
}))
vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: {},
    exists: vi.fn(),
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
}))
vi.mock('localforage', () => ({
    default: {
        createInstance: () => ({
            getItem: async () => null,
            setItem: async () => {},
        }),
    },
}))

import { buildServerSavePayload, decodeRisuSave, RisuSaveEncoder, type toSaveType } from './risuSave'
import { saveDatabaseOnNodeServer } from './nodeServerSave'
import type { NodeDatabaseSaveResult } from './nodeStorage'

const require = createRequire(import.meta.url)
const {
    BACKUP_PREFIX,
    DATABASE_KEY,
    DatabaseSaveError,
    DatabaseSaveStore,
    storageFileName,
    storageKey,
} = require('../../../server/node/dbSave.cjs')

type SaveResult = { revision: string, receivedBlocks: number, totalBlocks: number, size: number }

/** Stands in for NodeStorage + server.cjs: hands the payload to the server-side store */
function connect(getStore: () => InstanceType<typeof DatabaseSaveStore>) {
    const results: (SaveResult | 'stale')[] = []
    return {
        results,
        async saveDatabase(payload: Uint8Array): Promise<NodeDatabaseSaveResult> {
            try {
                const result: SaveResult = await getStore().save(Buffer.from(payload))
                results.push(result)
                return { status: 'saved', revision: result.revision }
            } catch (error) {
                if (error instanceof DatabaseSaveError && error.code === 'DB_SAVE_STALE') {
                    results.push('stale')
                    return { status: 'stale' }
                }
                throw error
            }
        },
    }
}

function character(id: string, text: string) {
    return {
        chaId: id,
        name: id,
        chatPage: 0,
        chats: [{ id: `chat-${id}`, message: [{ role: 'user', data: text }] }],
    }
}

function makeDatabase(): any {
    return {
        characters: [character('alpha', 'x'.repeat(8000)), character('beta', 'hello')],
        botPresets: [{ name: 'preset' }],
        botPresetsId: 0,
        modules: [],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: {},
        username: 'tester',
    }
}

function changes(partial: Partial<toSaveType> = {}): toSaveType {
    return {
        character: [],
        chat: [],
        botPreset: false,
        modules: false,
        loadouts: false,
        plugins: false,
        pluginCustomStorage: false,
        ...partial,
    }
}

describe('saving through the Node server', () => {
    let dir: string
    let clock: number

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'risu-db-save-'))
        clock = 17_000_000_000_000
        vi.spyOn(console, 'log').mockImplementation(() => {})
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await rm(dir, { recursive: true, force: true })
    })

    function newStore(options: { maxBackups?: number } = {}) {
        return new DatabaseSaveStore(dir, { ...options, now: () => clock })
    }

    async function readSavedDatabase() {
        const file = await readFile(path.join(dir, storageFileName(DATABASE_KEY)))
        return (await decodeRisuSave(new Uint8Array(file))).database as any
    }

    async function backupKeys() {
        return (await readdir(dir))
            .map((fileName) => storageKey(fileName))
            .filter((key) => key?.startsWith(BACKUP_PREFIX))
            .sort()
    }

    async function newEncoder(db: any) {
        const encoder = new RisuSaveEncoder({ cache: false })
        await encoder.init(db)
        return encoder
    }

    it('sends every block once, then only the changed ones', async () => {
        const store = newStore()
        const server = connect(() => store)
        const db = makeDatabase()
        const encoder = await newEncoder(db)

        await expect(saveDatabaseOnNodeServer(encoder, server)).resolves.toBe('saved')
        const first = server.results[0] as SaveResult
        expect(first.receivedBlocks).toBe(first.totalBlocks)

        db.characters[1].chats[0].message.push({ role: 'char', data: 'reply' })
        await encoder.set(db, changes({ character: ['beta'] }))
        await expect(saveDatabaseOnNodeServer(encoder, server)).resolves.toBe('saved')

        //the changed character and the root block, which is rebuilt on every save
        const second = server.results[1] as SaveResult
        expect(second.receivedBlocks).toBe(2)
        expect(second.totalBlocks).toBe(first.totalBlocks)

        const saved = await readSavedDatabase()
        expect(saved.username).toBe('tester')
        expect(saved.characters.map((c: any) => c.chaId)).toEqual(['alpha', 'beta'])
        expect(saved.characters[0].chats[0].message[0].data).toBe('x'.repeat(8000))
        expect(saved.characters[1].chats[0].message).toEqual([
            { role: 'user', data: 'hello' },
            { role: 'char', data: 'reply' },
        ])
    })

    it('gzips large blocks on the server', async () => {
        const store = newStore()
        const server = connect(() => store)
        const encoder = await newEncoder(makeDatabase())

        await saveDatabaseOnNodeServer(encoder, server)

        const file = await readFile(path.join(dir, storageFileName(DATABASE_KEY)))
        expect(file.length).toBeLessThan(new Uint8Array(encoder.encode()).length)
    })

    it('drops blocks of deleted characters', async () => {
        const store = newStore()
        const server = connect(() => store)
        const db = makeDatabase()
        const encoder = await newEncoder(db)
        await saveDatabaseOnNodeServer(encoder, server)

        db.characters = db.characters.filter((c: any) => c.chaId !== 'beta')
        await encoder.set(db, changes({ character: ['beta'] }))
        await saveDatabaseOnNodeServer(encoder, server)

        expect((await readSavedDatabase()).characters.map((c: any) => c.chaId)).toEqual(['alpha'])
    })

    it('sends every block again when the server lost the last save', async () => {
        let store = newStore()
        const server = connect(() => store)
        const db = makeDatabase()
        const encoder = await newEncoder(db)
        await saveDatabaseOnNodeServer(encoder, server)

        //a restart: the new process has no blocks in memory
        store = newStore()
        db.username = 'renamed'
        await encoder.set(db, changes())
        await expect(saveDatabaseOnNodeServer(encoder, server)).resolves.toBe('saved')
        expect(server.results[1]).toBe('stale')
        const full = server.results[2] as SaveResult
        expect(full.receivedBlocks).toBe(full.totalBlocks)

        //database.bin replaced through /api/write
        store.invalidate()
        db.username = 'renamed again'
        await encoder.set(db, changes())
        await expect(saveDatabaseOnNodeServer(encoder, server)).resolves.toBe('saved')
        expect(server.results[3]).toBe('stale')

        const saved = await readSavedDatabase()
        expect(saved.username).toBe('renamed again')
        expect(saved.characters.map((c: any) => c.chaId)).toEqual(['alpha', 'beta'])
    })

    it('does not mix in blocks from a save made by another device', async () => {
        const store = newStore()
        const server = connect(() => store)
        const dbA = makeDatabase()
        const encoderA = await newEncoder(dbA)
        await saveDatabaseOnNodeServer(encoderA, server)

        //another device saves its own copy, with the same block names
        const dbB = makeDatabase()
        dbB.characters[0].chats[0].message[0].data = 'from device B'
        await saveDatabaseOnNodeServer(await newEncoder(dbB), server)

        dbA.username = 'device A'
        await encoderA.set(dbA, changes())
        await saveDatabaseOnNodeServer(encoderA, server)
        expect(server.results[2]).toBe('stale')

        //last writer wins, as with whole-file uploads, but never a mix of both
        const saved = await readSavedDatabase()
        expect(saved.username).toBe('device A')
        expect(saved.characters[0].chats[0].message[0].data).toBe('x'.repeat(8000))
    })

    it('writes a backup on every save and keeps only the newest ones', async () => {
        const store = newStore({ maxBackups: 3 })
        const server = connect(() => store)
        const db = makeDatabase()
        const encoder = await newEncoder(db)

        for (let i = 0; i < 5; i++) {
            clock += 1000
            db.username = `save ${i}`
            await encoder.set(db, changes())
            await saveDatabaseOnNodeServer(encoder, server)
        }

        const keys = await backupKeys()
        expect(keys).toEqual([3, 4, 5].map((i) => `${BACKUP_PREFIX}${((17_000_000_000_000 + i * 1000) / 100).toFixed()}.bin`))
        const newest = await readFile(path.join(dir, storageFileName(keys[2])))
        const current = await readFile(path.join(dir, storageFileName(DATABASE_KEY)))
        expect(newest.equals(current)).toBe(true)
    })

    it('reports an unsupported server without changing the encoder state', async () => {
        const store = newStore()
        const server = connect(() => store)
        const encoder = await newEncoder(makeDatabase())
        await saveDatabaseOnNodeServer(encoder, server)

        await expect(saveDatabaseOnNodeServer(encoder, {
            saveDatabase: async () => ({ status: 'unsupported' }),
        })).resolves.toBe('unsupported')

        //the next request still builds on the acknowledged save
        await saveDatabaseOnNodeServer(encoder, server)
        expect((server.results[1] as SaveResult).receivedBlocks).toBe(0)
    })

    it('rejects malformed requests', async () => {
        const store = newStore()
        const encoder = await newEncoder(makeDatabase())
        const request = encoder.encodeServerSave()!

        const expectInvalid = async (payload: Uint8Array) => {
            await expect(store.save(Buffer.from(payload))).rejects.toMatchObject({ status: 400, code: 'DB_SAVE_INVALID' })
        }
        //cut inside a block
        await expectInvalid(request.payload.subarray(0, request.payload.length - 10))
        //a full save that leaves out blocks
        await expectInvalid(buildServerSavePayload({ v: 1, base: null, order: ['config', 'root'] }, []))
        //a block that is not in the order
        const manifestLength = new DataView(request.payload.buffer, request.payload.byteOffset).getUint32(0, true)
        await expectInvalid(buildServerSavePayload(
            { v: 1, base: null, order: ['config'] },
            [request.payload.subarray(4 + manifestLength)]
        ))
        //an unknown base revision
        await expect(store.save(Buffer.from(buildServerSavePayload({ v: 1, base: 'unknown', order: ['config'] }, []))))
            .rejects.toMatchObject({ status: 409, code: 'DB_SAVE_STALE' })
    })
})
