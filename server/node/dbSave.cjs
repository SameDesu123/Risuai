// Server-side saving of database/database.bin for the Node server.
//
// The browser sends only the RisuSave blocks that changed since its last save.
// The server keeps every block of the last save in memory, gzips the large ones,
// assembles the file, writes it and its backup, and prunes old backups.
// The files keep the layout of /api/write (hex-encoded storage keys in the save
// folder), so the browser still reads them through /api/read as before.

const path = require('path')
const fs = require('fs/promises')
const crypto = require('crypto')
const zlib = require('zlib')
const { promisify } = require('util')

const gzip = promisify(zlib.gzip)

const PROTOCOL_VERSION = 1
const DATABASE_KEY = 'database/database.bin'
const BACKUP_PREFIX = 'database/dbbackup-'
const MAX_BACKUPS = 20
const RISUSAVE_MAGIC = Buffer.from('RISUSAVE\0', 'utf-8')
// RisuSaveType values from src/ts/storage/risuSave.ts
const BLOCK_TYPE_CONFIG = 0
const BLOCK_TYPE_REMOTE = 6
// Smaller blocks are left as they are: gzip would barely shrink them
const COMPRESS_MIN_BYTES = 1024
// Not a hex name, so /api/read never serves it and /api/list lists it as an empty key, like __password
const TEMP_FILE_NAME = '__database_save.tmp'
const hexRegex = /^[0-9a-fA-F]+$/

class DatabaseSaveError extends Error {
    constructor(status, code, message) {
        super(message)
        this.status = status
        this.code = code
    }
}

function invalidRequest(message) {
    return new DatabaseSaveError(400, 'DB_SAVE_INVALID', message)
}

function storageFileName(key) {
    return Buffer.from(key, 'utf-8').toString('hex')
}

function storageKey(fileName) {
    if (typeof fileName !== 'string' || !hexRegex.test(fileName.trim())) {
        return null
    }
    return Buffer.from(fileName.trim(), 'hex').toString('utf-8')
}

function isDatabaseFile(fileName) {
    return storageKey(fileName) === DATABASE_KEY
}

// Block layout, as written by RisuSaveEncoder.encodeRawBlock:
// [type u8][compressed u8][name length u8][name][data length u32 LE][data]
function readBlock(buffer, offset) {
    if (offset + 3 > buffer.length) {
        throw invalidRequest('Truncated block header')
    }
    const type = buffer[offset]
    const compressed = buffer[offset + 1] === 1
    const nameLength = buffer[offset + 2]
    const nameEnd = offset + 3 + nameLength
    if (nameEnd + 4 > buffer.length) {
        throw invalidRequest('Truncated block header')
    }
    const name = buffer.toString('utf-8', offset + 3, nameEnd)
    const dataLength = buffer.readUInt32LE(nameEnd)
    const end = nameEnd + 4 + dataLength
    if (end > buffer.length) {
        throw invalidRequest(`Truncated data in block ${name}`)
    }
    return {
        type,
        compressed,
        name,
        data: buffer.subarray(nameEnd + 4, end),
        bytes: buffer.subarray(offset, end),
        end,
    }
}

function encodeBlock(type, compressed, name, data) {
    const nameBuf = Buffer.from(name, 'utf-8')
    const header = Buffer.alloc(3 + nameBuf.length + 4)
    header[0] = type
    header[1] = compressed ? 1 : 0
    header[2] = nameBuf.length
    nameBuf.copy(header, 3)
    header.writeUInt32LE(data.length, 3 + nameBuf.length)
    return Buffer.concat([header, data])
}

// Request body: [manifest length u32 LE][manifest JSON][blocks]
// manifest: { v: 1, base: revision of the last save | null for a full save, order: every block name, in file order }
function parseSaveRequest(body) {
    if (!Buffer.isBuffer(body) || body.length < 4) {
        throw invalidRequest('Missing request body')
    }
    const manifestLength = body.readUInt32LE(0)
    if (4 + manifestLength > body.length) {
        throw invalidRequest('Truncated manifest')
    }
    let manifest
    try {
        manifest = JSON.parse(body.toString('utf-8', 4, 4 + manifestLength))
    } catch {
        throw invalidRequest('Invalid manifest')
    }
    if (!manifest || manifest.v !== PROTOCOL_VERSION) {
        throw invalidRequest('Unsupported save protocol version')
    }
    const base = manifest.base ?? null
    if (base !== null && typeof base !== 'string') {
        throw invalidRequest('Invalid base revision')
    }
    const order = manifest.order
    if (!Array.isArray(order) || order.length === 0 || order.some((name) => typeof name !== 'string')) {
        throw invalidRequest('Invalid block order')
    }
    const names = new Set(order)
    if (names.size !== order.length) {
        throw invalidRequest('Duplicate block names')
    }

    const blocks = new Map()
    let offset = 4 + manifestLength
    while (offset < body.length) {
        const block = readBlock(body, offset)
        if (!names.has(block.name)) {
            throw invalidRequest(`Block ${block.name} is not in the block order`)
        }
        if (blocks.has(block.name)) {
            throw invalidRequest(`Block ${block.name} was sent twice`)
        }
        blocks.set(block.name, block)
        offset = block.end
    }
    if (base === null && blocks.size !== order.length) {
        throw invalidRequest('A full save must send every block')
    }
    return { base, order, blocks }
}

// Returns a standalone copy of the block, so the request body is not kept alive
async function compressBlock(block) {
    if (
        block.compressed ||
        block.type === BLOCK_TYPE_CONFIG ||
        block.type === BLOCK_TYPE_REMOTE ||
        block.data.length < COMPRESS_MIN_BYTES
    ) {
        return Buffer.from(block.bytes)
    }
    const compressed = await gzip(block.data)
    if (compressed.length >= block.data.length) {
        return Buffer.from(block.bytes)
    }
    return encodeBlock(block.type, true, block.name, compressed)
}

class DatabaseSaveStore {
    constructor(savePath, options = {}) {
        this.savePath = savePath
        this.maxBackups = options.maxBackups ?? MAX_BACKUPS
        this.now = options.now ?? Date.now
        this.revision = null
        this.blocks = new Map()
        this.queue = Promise.resolve()
    }

    // database.bin was changed some other way: the next save must send every block
    invalidate() {
        this.revision = null
        this.blocks = new Map()
    }

    // Saves run one at a time, in the order they arrive
    save(body) {
        const run = this.queue.then(() => this.saveNow(body))
        this.queue = run.catch(() => {})
        return run
    }

    async saveNow(body) {
        const request = parseSaveRequest(body)
        if (request.base !== null && request.base !== this.revision) {
            throw new DatabaseSaveError(409, 'DB_SAVE_STALE', 'The server copy of the database changed since the last save')
        }

        const blocks = new Map()
        for (const name of request.order) {
            const sent = request.blocks.get(name)
            if (sent) {
                blocks.set(name, await compressBlock(sent))
                continue
            }
            const kept = this.blocks.get(name)
            if (!kept) {
                throw new DatabaseSaveError(409, 'DB_SAVE_STALE', `The server does not have block ${name}`)
            }
            blocks.set(name, kept)
        }
        const file = Buffer.concat([RISUSAVE_MAGIC, ...blocks.values()])

        // Only a save that completes sets a revision again
        this.invalidate()
        await this.writeDatabase(file)
        const backupKey = `${BACKUP_PREFIX}${(this.now() / 100).toFixed()}.bin`
        await fs.writeFile(path.join(this.savePath, storageFileName(backupKey)), file)
        await this.pruneBackups()

        this.blocks = blocks
        this.revision = crypto.randomBytes(16).toString('hex')
        return {
            revision: this.revision,
            receivedBlocks: request.blocks.size,
            totalBlocks: request.order.length,
            size: file.length,
        }
    }

    async writeDatabase(file) {
        const target = path.join(this.savePath, storageFileName(DATABASE_KEY))
        const temp = path.join(this.savePath, TEMP_FILE_NAME)
        await fs.writeFile(temp, file)
        try {
            await fs.rename(temp, target)
        } catch (error) {
            // Windows can refuse to replace a file that another program holds open
            console.warn('[Storage] Could not replace the database file atomically, writing it in place:', error?.code ?? error)
            await fs.writeFile(target, file)
            await fs.rm(temp, { force: true })
        }
    }

    async pruneBackups() {
        const backups = []
        for (const fileName of await fs.readdir(this.savePath)) {
            const key = storageKey(fileName)
            if (!key || !key.startsWith(BACKUP_PREFIX) || !key.endsWith('.bin')) {
                continue
            }
            const time = parseInt(key.slice(BACKUP_PREFIX.length, -4))
            if (Number.isFinite(time)) {
                backups.push({ time, fileName })
            }
        }
        backups.sort((a, b) => b.time - a.time)
        for (const backup of backups.slice(this.maxBackups)) {
            await fs.rm(path.join(this.savePath, backup.fileName), { force: true })
        }
    }
}

module.exports = {
    DATABASE_KEY,
    BACKUP_PREFIX,
    DatabaseSaveError,
    DatabaseSaveStore,
    isDatabaseFile,
    parseSaveRequest,
    storageFileName,
    storageKey,
}
