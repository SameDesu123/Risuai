import { Packr, Unpackr, decode } from "msgpackr/index-no-eval";
import * as fflate from "fflate";
import { getDatabase, presetTemplate, type Database } from "./database.svelte";
import localforage from "localforage";
import { forageStorage } from "../globalApi.svelte";
import { isNodeServer, isTauri } from "src/ts/platform"
import type { SaveKVData, SaveKVSource } from "./saveKV"
import {
    writeFile,
    BaseDirectory,
    exists,
    mkdir,
    readFile,
    readDir,
    rename,
} from "@tauri-apps/plugin-fs"
import {
    getRemoteChatPayloadName,
    parseRemoteSaveFileName,
    remoteSaveBackupSuffix,
    remoteSaveChatPrefix,
    remoteSaveCorruptMarker,
    remoteSavePayloadExtension,
    remoteSaveTempSuffix,
} from "./remoteSaveCleanup"

const packr = new Packr({
    useRecords:false
});

const unpackr = new Unpackr({
    int64AsType: 'number',
    useRecords:false
})

const disableRemoteSaving = () => {
    try {
        const db = getDatabase()
        return !db.enableRemoteSaving
    } catch (error) {
        return true
    }
}
const checkedRemoteExistence = new Set<string>();
/** remote chat files whose version from before this app session was already preserved (or did not exist) */
const backedUpRemoteFiles = new Set<string>();
/** remote payload names this app session has written (startup cleanup must not touch their temp files) */
const writtenRemoteFiles = new Set<string>();
let remotesDirReady = false;
const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]); 
const magicCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);
const magicStreamCompressedHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 9]);
const magicRisuSaveHeader = new TextEncoder().encode("RISUSAVE\0");


async function checkCompressionStreams(){
    if(!CompressionStream){
        const {makeCompressionStream} = await import('compression-streams-polyfill/ponyfill');
        //@ts-expect-error polyfill CompressionStream type is incompatible with globalThis.CompressionStream
        globalThis.CompressionStream = makeCompressionStream(TransformStream);
    }
    if(!DecompressionStream){
        const {makeDecompressionStream} = await import('compression-streams-polyfill/ponyfill');
        //@ts-expect-error polyfill DecompressionStream type is incompatible with globalThis.DecompressionStream
        globalThis.DecompressionStream = makeDecompressionStream(TransformStream);
    }
}

export async function encodeRisuSaveCompressionStream(data:any) {
    await checkCompressionStreams()
    let encoded:Uint8Array = packr.encode(data)
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(encoded as any);
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer()
    const result = new Uint8Array(new Uint8Array(buf).length + magicStreamCompressedHeader.length);
    result.set(magicStreamCompressedHeader, 0)
    result.set(new Uint8Array(buf), magicStreamCompressedHeader.length)
    return result
}

export type toSaveType = {
    /** chaIds whose blocks must be re-encoded (an id that is no longer in the database means the character was deleted) */
    character: string[];
    /**
     * [chaId, chatId] pairs of chats that changed. Only used when chats are saved as separate blocks.
     * A dirty character without any entry here (and not in allChats) has all of its chats re-encoded.
     */
    chat: [string, string][];
    /** chaIds whose chats must all be re-encoded. Only used when chats are saved as separate blocks. */
    allChats?: string[];
    botPreset: boolean;
    modules: boolean;
    loadouts: boolean;
    plugins: boolean;
    pluginCustomStorage: boolean;
    /** SaveKV namespaces to re-encode */
    kv?: string[];
}

enum RisuSaveType {
    CONFIG = 0,
    ROOT = 1,
    CHARACTER_WITH_CHAT = 2,
    CHAT = 3,
    BOTPRESET = 4,
    MODULES = 5,
    REMOTE = 6,
    CHARACTER_WITHOUT_CHAT = 7,
    ROOT_COMPONENT = 8,
    PLUGINS = 9,
    LOADOUTS = 10,
    PLUGIN_STORAGE = 11,
    /** SaveKV namespace (`kv:<namespace>`), see saveKV.ts */
    KV = 12,
}

const KV_BLOCK_PREFIX = 'kv:'

/**
 * Split chat storage (opt-in, see RisuSaveEncoder's splitChats option):
 * - a CHARACTER_WITHOUT_CHAT block named after the chaId holds the character JSON, but its `chats`
 *   property is replaced with `{ "__risuSplitChats": 1, "ids": [chatId, ...] }` (the chat order).
 *   A legacy CHARACTER_WITHOUT_CHAT block with a `chats` array is still read as a full character.
 *   An object in `chats` is also not iterable for older clients, which makes them fail to load
 *   the save (and fall back to backups) instead of silently loading characters without chats.
 * - one CHAT block per chat, named `chat-<chaId>-<chatId>`, holding
 *   `{ "v": 1, "chaId": ..., "chatId": ..., "chat": {...} }`. The decoder only uses the payload,
 *   never the name (the name is ambiguous: `chat-a-b-c` may be chaId `a` or `a-b`).
 * - the decoder detects the marker in CHARACTER_WITH_CHAT blocks too: a crash between writing a
 *   remote character file and database.bin can leave an old pointer type in front of a new file.
 *
 * Together with remote saving (Tauri / Node server), the character block and every chat block are
 * remote blocks, so each chat is its own file `remotes/chat-<chaId>-<chatId>.local.bin`:
 * - only ids matching SAFE_REMOTE_ID (and short enough names) are used as file names; other
 *   characters are saved as a single legacy remote block.
 * - Tauri writes every remote file to `<file>.tmp` and renames it over the file. The Node server has
 *   no rename, so files are written in place.
 * - the first overwrite of a chat file in an app session keeps the previous version as `<file>.bak`.
 *   A previous version that does not parse is moved to `<file>.corrupt-<time>` instead, so a good
 *   `.bak` is never replaced by a broken file.
 * - the decoder falls back to `.bak` when a chat file is missing or does not parse, and probes for the
 *   files of listed chats that have no block in database.bin (the character's chat list is the source
 *   of truth). The decoder never writes, renames or deletes files.
 */
const SPLIT_CHATS_KEY = '__risuSplitChats'
const CHAT_BLOCK_PREFIX = remoteSaveChatPrefix
const MAX_BLOCK_NAME_BYTES = 255
/** ids that may be part of a remote file name */
const SAFE_REMOTE_ID = /^[A-Za-z0-9_-]+$/
/** longest chat block name stored as a remote file on Tauri */
const MAX_REMOTE_CHAT_NAME_BYTES = 200
/**
 * The Node server stores each key as one hex encoded file name (2 bytes per byte, at most 255), and the
 * longest key is `remotes/<name>.local.bin.corrupt-<13 digits>` (40 bytes besides the name).
 */
const MAX_REMOTE_CHAT_NAME_BYTES_NODE = 87
const REMOTE_READ_CONCURRENCY = 16
const RESERVED_BLOCK_NAMES = new Set(['root', 'preset', 'modules', 'loadouts', 'plugins', 'pluginStorage', 'config'])

type ChatBlockPayload = {
    v: number
    chaId: string
    chatId: string
    chat: any
}

function utf8Length(str:string){
    return new TextEncoder().encode(str).length
}

function chatBlockName(chaId:string, chatId:string){
    return getRemoteChatPayloadName(chaId, chatId)
}

function remoteFilePath(name:string){
    return `remotes/${name}${remoteSavePayloadExtension}`
}

function maxRemoteChatNameBytes(){
    return isTauri ? MAX_REMOTE_CHAT_NAME_BYTES : MAX_REMOTE_CHAT_NAME_BYTES_NODE
}

/** true if the chat of a character may be stored as (and probed for as) its own remote file */
function isSafeRemoteChat(chaId:string, chatId:string){
    return SAFE_REMOTE_ID.test(chaId) &&
        SAFE_REMOTE_ID.test(chatId) &&
        utf8Length(chatBlockName(chaId, chatId)) <= maxRemoteChatNameBytes()
}

function isJsonText(text:string){
    try {
        JSON.parse(text)
        return true
    } catch (error) {
        return false
    }
}

function toBytes(data:Uint8Array|ArrayBuffer){
    return data instanceof Uint8Array ? data : new Uint8Array(data)
}

/** runs at most `limit` tasks at once; results keep the order of the calls that created them */
function createLimiter(limit:number){
    let active = 0
    const queue:(() => void)[] = []
    return <T>(task:() => Promise<T>):Promise<T> => {
        return new Promise<T>((resolve, reject) => {
            const run = () => {
                active++
                task().then(resolve, reject).finally(() => {
                    active--
                    queue.shift()?.()
                })
            }
            if(active < limit){
                run()
            }
            else{
                queue.push(run)
            }
        })
    }
}

/**
 * True if a file in `remotes/` (name without the folder) belongs to a payload this app session writes.
 * Startup cleanup uses this to leave temp files of writes that may be in progress alone.
 */
export function isRemoteSaveFileInUse(fileName:string){
    const { payloadName } = parseRemoteSaveFileName(fileName)
    return payloadName !== null && writtenRemoteFiles.has(payloadName)
}

/** forgets the per-session remote file state, as if the app was restarted (tests) */
export function resetRemoteSaveSession(){
    checkedRemoteExistence.clear()
    backedUpRemoteFiles.clear()
    writtenRemoteFiles.clear()
    remotesDirReady = false
}

async function ensureRemotesDir(){
    if(remotesDirReady){
        return
    }
    if(!(await exists('remotes', { baseDir: BaseDirectory.AppData }))){
        await mkdir('remotes', { recursive: true, baseDir: BaseDirectory.AppData });
    }
    remotesDirReady = true
}

/**
 * Keeps the version of a chat file from before this app session: as `.bak` if it parses,
 * otherwise as `.corrupt-<time>` (an existing `.bak` is left alone then).
 * Tauri moves the file away; the caller renames the new file in right after.
 */
async function preserveRemoteFile(fileName:string){
    if(isTauri){
        if(!(await exists(fileName, { baseDir: BaseDirectory.AppData }))){
            return
        }
        const previous = await readFile(fileName, { baseDir: BaseDirectory.AppData })
        const target = isJsonText(new TextDecoder().decode(previous))
            ? fileName + remoteSaveBackupSuffix
            : `${fileName}${remoteSaveCorruptMarker}${Date.now()}`
        await rename(fileName, target, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData })
        return
    }
    const previous = await forageStorage.getItem(fileName)
    if(!previous){
        return
    }
    const bytes = toBytes(previous)
    if(isJsonText(new TextDecoder().decode(bytes))){
        await forageStorage.setItem(fileName + remoteSaveBackupSuffix, bytes)
    }
    else{
        await forageStorage.setItem(`${fileName}${remoteSaveCorruptMarker}${Date.now()}`, bytes)
    }
}

/** writes a remote block file (atomically on Tauri), keeping a session-first backup for chat files */
async function writeRemoteFile(name:string, data:Uint8Array, keepSessionBackup:boolean){
    const fileName = remoteFilePath(name)
    writtenRemoteFiles.add(name)
    const backup = keepSessionBackup && !backedUpRemoteFiles.has(name)
    if(isTauri){
        await ensureRemotesDir()
        const tempName = fileName + remoteSaveTempSuffix
        await writeFile(tempName, data, { baseDir: BaseDirectory.AppData })
        if(backup){
            try {
                await preserveRemoteFile(fileName)
                backedUpRemoteFiles.add(name)
            } catch (error) {
                console.warn(`Could not keep the previous version of ${fileName}:`, error)
            }
        }
        try {
            await rename(tempName, fileName, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData })
        } catch (error) {
            console.warn(`Could not move ${tempName} into place, writing ${fileName} directly:`, error)
            await writeFile(fileName, data, { baseDir: BaseDirectory.AppData })
        }
        return
    }
    if(backup){
        try {
            await preserveRemoteFile(fileName)
            backedUpRemoteFiles.add(name)
        } catch (error) {
            console.warn(`Could not keep the previous version of ${fileName}:`, error)
        }
    }
    await forageStorage.setItem(fileName, data)
}

async function readRemoteFile(fileName:string):Promise<Uint8Array|null>{
    try {
        if(isTauri){
            if(await exists(fileName, { baseDir: BaseDirectory.AppData })){
                return await readFile(fileName, { baseDir: BaseDirectory.AppData })
            }
            return null
        }
        const stored = await forageStorage.getItem(fileName)
        return stored ? toBytes(stored) : null
    } catch (error) {
        console.error(`Error reading remote file ${fileName}:`, error)
        return null
    }
}

/**
 * Reads the content of a remote block file. With `withBackup` (chat files), a missing or unparsable
 * file falls back to its `.bak`. Never throws, never writes.
 */
async function readRemotePayload(name:string, withBackup:boolean):Promise<string|null>{
    try {
        const fileName = remoteFilePath(name)
        const main = await readRemoteFile(fileName)
        if(!withBackup){
            return main ? new TextDecoder().decode(main) : null
        }
        if(main){
            const text = new TextDecoder().decode(main)
            if(isJsonText(text)){
                return text
            }
            console.warn(`Remote file ${fileName} is corrupt, trying its backup.`)
        }
        const backup = await readRemoteFile(fileName + remoteSaveBackupSuffix)
        if(backup){
            const text = new TextDecoder().decode(backup)
            if(isJsonText(text)){
                console.warn(`Loading ${fileName} from its backup.`)
                return text
            }
        }
        return null
    } catch (error) {
        console.error(`Error reading remote block ${name}:`, error)
        return null
    }
}

/** returns the recorded chat order of a split character, or null if the character holds its chats itself */
function getSplitChatIds(character:any):string[]|null{
    const chats = character?.chats
    if(!chats || typeof chats !== 'object' || Array.isArray(chats) || !(SPLIT_CHATS_KEY in chats)){
        return null
    }
    if(!Array.isArray(chats.ids)){
        return []
    }
    return chats.ids.filter((id:unknown) => typeof id === 'string')
}

function makeMissingChatPlaceholder(chatId:string){
    return {
        id: chatId,
        name: 'Chat (failed to load)',
        note: '',
        localLore: [],
        message: [{
            time: Date.now(),
            data: `[Chat data could not be loaded. Chat ID: ${chatId}. It may still be recoverable from a backup.]`,
            role: 'char'
        }]
    }
}

type CharacterEncodeContext = {
    /** every chaId in the database */
    chaIds: Set<string>
    /** chaIds used by more than one character */
    duplicateChaIds: Set<string>
}

/** 'all', or the ids of the chats that changed */
type DirtyChats = 'all' | Set<string>

type EncodeBlockArg = {
    compression:boolean
    data:string
    type:RisuSaveType
    name:string
    cache?:boolean
    skipRemoteSaving?:boolean
}

type EncodeBlockOption = {
    remote: 'none'|'prefer'|'force'
}

const risuSaveCacheForage = localforage.createInstance({
    name: 'risuSaveCache'
});
export class RisuSaveEncoder {

    private blocks: { [key: string]: Uint8Array } = {};
    private compression: boolean = false;
    private kv: SaveKVSource | null = null;
    /** false: never write blocks to separate remote files (self-contained exports) */
    private allowRemote: boolean;
    /** false: do not write blocks to the local block cache (exports must not touch the live save's cache) */
    private cacheBlocks: boolean;
    /** true: save each chat of a character as its own block (older clients cannot read this) */
    readonly splitChats: boolean;
    /** chaId -> (chatId -> chat block name) for characters currently saved as split blocks */
    private splitChatBlocks: Map<string, Map<string, string>> = new Map();
    /** chat block name -> chaId of the character that owns it */
    private chatBlockOwner: Map<string, string> = new Map();
    /** paths of the existing remote files, listed once per init (null outside init) */
    private remoteListing: Promise<Set<string>> | null = null;
    /** chaId -> content of the split character file this encoder last wrote (unchanged files are not rewritten) */
    private remoteCharacterContent: Map<string, string> = new Map();
    private listingRemoteFiles = false;

    constructor(options: { remote?: boolean, cache?: boolean, splitChats?: boolean } = {}){
        this.allowRemote = options.remote ?? true;
        this.cacheBlocks = options.cache ?? true;
        this.splitChats = options.splitChats ?? false;
    }

    async init(data:Database,arg:{
        compression?: boolean,
        skipRemoteSavingOnCharacters?: boolean,
        kv?: SaveKVSource | null
    } = {}){
        const {
            compression = false,
            skipRemoteSavingOnCharacters = true,
            kv = null
        } = arg;
        this.compression = compression;
        this.kv = kv;
        this.remoteListing = null;
        this.listingRemoteFiles = true;
        try {
            await this.encodeAll(data, skipRemoteSavingOnCharacters);
        } finally {
            this.listingRemoteFiles = false;
            this.remoteListing = null;
        }
    }

    private async encodeAll(data:Database, skipRemoteSavingOnCharacters:boolean){
        const compression = this.compression;
        const kv = this.kv;
        let obj:Record<any,any> = {}
        let keys = Object.keys(data)
        for(const key of keys){
            if(key !== 'characters' && key !== 'botPresets' && key !== 'modules'){
                obj[key] = data[key]
            }
        }
        this.blocks['root'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(obj),
            type: RisuSaveType.ROOT,
            name: 'root'
        });
        this.blocks['preset'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(data.botPresets),
            type: RisuSaveType.BOTPRESET,
            name: 'preset'
        });
        this.blocks['modules'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(data.modules),
            type: RisuSaveType.MODULES,
            name: 'modules'
        });
        this.blocks['loadouts'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(data.loadouts),
            type: RisuSaveType.LOADOUTS,
            name: 'loadouts'
        });
        this.blocks['plugins'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(data.plugins),
            type: RisuSaveType.PLUGINS,
            name: 'plugins'
        });
        this.blocks['pluginStorage'] = await this.encodeBlock({
            compression,
            data: JSON.stringify(data.pluginCustomStorage),
            type: RisuSaveType.PLUGIN_STORAGE,
            name: 'pluginStorage'
        });
        const context = this.makeCharacterContext(data);
        for( const character of data.characters ?? []) {
            await this.encodeCharacter(character, context, 'all', skipRemoteSavingOnCharacters);
        }
        for(const ns of kv?.namespaces() ?? []){
            await this.encodeKVBlock(ns);
        }
        this.blocks['config'] = await this.encodeBlock({
            compression,
            data: JSON.stringify({
                version: 1
            }),
            type: RisuSaveType.CONFIG,
            name: "config"
        })
    }

    async set(data:Database, toSave:toSaveType){
        let obj:Record<any,any> = {}
        let keys = Object.keys(data)
        for(const key of keys){
            if(
                key !== 'characters' && key !== 'botPresets' && key !== 'modules' &&
                key !== 'loadouts' && key !== 'plugins' && key !== 'pluginCustomStorage'
            ){
                obj[key] = data[key]
            }
        }

        const context = this.makeCharacterContext(data);
        await this.releaseCollidingChatBlocks(data, context);

        const dirtyChats = new Map<string, Set<string>>();
        for(const [chaId, chatId] of toSave.chat ?? []){
            if(!dirtyChats.has(chaId)){
                dirtyChats.set(chaId, new Set());
            }
            dirtyChats.get(chaId).add(chatId);
        }
        const allChatsDirty = new Set(toSave.allChats ?? []);

        const savedId = new Set<string>();
        for(const character of data.characters) {
            const index = toSave.character.indexOf(character.chaId);
            if (index !== -1) {
                //no chat information for a dirty character: treat every chat as dirty
                const dirty:DirtyChats = (allChatsDirty.has(character.chaId) || !dirtyChats.has(character.chaId))
                    ? 'all'
                    : dirtyChats.get(character.chaId);
                await this.encodeCharacter(character, context, dirty);
                savedId.add(character.chaId);
                toSave.character.splice(index, 1);
            }
            else if(!this.blocks[character.chaId]){
                await this.encodeCharacter(character, context, 'all');
                savedId.add(character.chaId);
            }
        }
        if(toSave.character.length > 0){
            console.log(`Deleting character data: ${toSave.character.join(', ')}`);
            //probably deleted characters
            for(const chaId of toSave.character){
                if(!savedId.has(chaId)){
                    if(!this.chatBlockOwner.has(chaId)){
                        delete this.blocks[chaId];
                    }
                    this.remoteCharacterContent.delete(chaId);
                    this.removeChatBlocks(chaId);
                }
            }
        }

        if(toSave.botPreset){
            this.blocks['preset'] = await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(data.botPresets),
                type: RisuSaveType.BOTPRESET,
                name: 'preset'
            });
        }
        if(toSave.modules){
            this.blocks['modules'] = await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(data.modules),
                type: RisuSaveType.MODULES,
                name: 'modules'
            });
        }

        if(toSave.loadouts){
            this.blocks['loadouts'] = await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(data.loadouts),
                type: RisuSaveType.LOADOUTS,
                name: 'loadouts'
            });
        }

        if(toSave.pluginCustomStorage){
            this.blocks['pluginStorage'] = await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(data.pluginCustomStorage),
                type: RisuSaveType.PLUGIN_STORAGE,
                name: 'pluginStorage'
            });
        }

        if(toSave.plugins){
            this.blocks['plugins'] = await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(data.plugins),
                type: RisuSaveType.PLUGINS,
                name: 'plugins'
            });
        }

        for(const ns of toSave.kv ?? []){
            await this.encodeKVBlock(ns);
        }

        obj["__directory"] = Object.keys(this.blocks).filter(key => key !== 'root');
        this.blocks['root'] = await this.encodeBlock({
            compression: this.compression,
            data: JSON.stringify(obj),
            type: RisuSaveType.ROOT,
            name: 'root'
        });
    }

    encode(arg:{
        compression?: boolean
    } = {}){
        if(!this.blocks['config']){
            return null
        }
        let totalLength = 0
        for(const key in this.blocks){
            totalLength += this.blocks[key].length;
        }
        totalLength += magicRisuSaveHeader.length;
        const arrayBuf = new ArrayBuffer(totalLength);
        const view = new Uint8Array(arrayBuf);
        let offset = 0;
        view.set(magicRisuSaveHeader, offset);
        offset += magicRisuSaveHeader.length;
        for(const key in this.blocks){
            view.set(this.blocks[key], offset);
            offset += this.blocks[key].length;
        }
        console.log(Object.keys(this.blocks).length, 'blocks encoded');
        return arrayBuf;
    }

    private async encodeKVBlock(ns: string){
        const name = KV_BLOCK_PREFIX + ns
        const content = this.kv ? this.kv.encodeNamespace(ns) : null
        if(content === null){
            delete this.blocks[name]
            return
        }
        this.blocks[name] = await this.encodeBlock({
            compression: this.compression,
            data: content,
            type: RisuSaveType.KV,
            name
        });
    }

    private makeCharacterContext(data:Database):CharacterEncodeContext{
        const chaIds = new Set<string>();
        const duplicateChaIds = new Set<string>();
        for(const character of data.characters ?? []){
            const chaId = character?.chaId;
            if(chaIds.has(chaId)){
                duplicateChaIds.add(chaId);
            }
            chaIds.add(chaId);
        }
        return { chaIds, duplicateChaIds };
    }

    /**
     * Returns the chat ids and block names to save the character as split blocks,
     * or null if this character must be saved as a single legacy block.
     */
    private planSplitCharacter(character:Database['characters'][number], context:CharacterEncodeContext){
        if(!this.splitChats){
            return null;
        }
        const chaId = character?.chaId;
        if(typeof chaId !== 'string' || chaId === '' || context.duplicateChaIds.has(chaId)){
            return null;
        }
        if(utf8Length(chaId) > MAX_BLOCK_NAME_BYTES || !Array.isArray(character.chats)){
            return null;
        }
        //with remote saving every block becomes a file named after it
        const remote = this.shouldEncodeRemote({ remote: 'prefer' });
        if(remote && !SAFE_REMOTE_ID.test(chaId)){
            return null;
        }
        const chatIds:string[] = [];
        const names:string[] = [];
        //chat references are taken now: the array may change while blocks are encoded (awaits in between)
        const chats = [...character.chats];
        const seen = new Set<string>();
        for(const chat of chats){
            const chatId = chat?.id;
            if(!chat || typeof chat !== 'object' || typeof chatId !== 'string' || chatId === '' || seen.has(chatId)){
                return null;
            }
            seen.add(chatId);
            const name = chatBlockName(chaId, chatId);
            if(
                utf8Length(name) > MAX_BLOCK_NAME_BYTES ||
                RESERVED_BLOCK_NAMES.has(name) ||
                name.startsWith(KV_BLOCK_PREFIX) ||
                context.chaIds.has(name)
            ){
                return null;
            }
            if(remote && !isSafeRemoteChat(chaId, chatId)){
                return null;
            }
            const owner = this.chatBlockOwner.get(name);
            if(owner !== undefined ? owner !== chaId : this.blocks[name] !== undefined){
                return null;
            }
            chatIds.push(chatId);
            names.push(name);
        }
        return { chaId, chatIds, names, chats, remote };
    }

    /** character JSON with `chats` replaced by the split marker and chat order, keeping the key order */
    private serializeSplitCharacter(character:Database['characters'][number], chatIds:string[]){
        const obj:Record<string, any> = {};
        for(const key of Object.keys(character)){
            obj[key] = key === 'chats' ? { [SPLIT_CHATS_KEY]: 1, ids: chatIds } : (character as Record<string, any>)[key];
        }
        return JSON.stringify(obj);
    }

    /**
     * Encodes a character either as split blocks or as a single legacy block, and removes blocks it no longer needs.
     * Blocks are only replaced after everything was encoded, so a failure leaves the previous blocks in place.
     */
    private async encodeCharacter(character:Database['characters'][number], context:CharacterEncodeContext, dirty:DirtyChats, skipRemoteSaving?:boolean){
        const plan = this.planSplitCharacter(character, context);
        if(!plan){
            const block = await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(character),
                type: RisuSaveType.CHARACTER_WITH_CHAT,
                name: character.chaId,
                skipRemoteSaving
            }, {
                remote: 'prefer'
            });
            this.blocks[character.chaId] = block;
            this.remoteCharacterContent.delete(character.chaId);
            this.removeChatBlocks(character.chaId);
            return;
        }

        const { chaId, chatIds, names, chats } = plan;
        //the names were checked for remote use only if the plan said so; do not re-evaluate the setting here
        const blockOption:EncodeBlockOption = { remote: plan.remote ? 'force' : 'none' };
        const previous = this.splitChatBlocks.get(chaId);
        const encodedChats:[string, Uint8Array][] = [];
        for(let i = 0; i < chatIds.length; i++){
            const name = names[i];
            const needsEncode = dirty === 'all' ||
                dirty.has(chatIds[i]) ||
                !previous?.has(chatIds[i]) ||
                this.blocks[name] === undefined;
            if(!needsEncode){
                continue;
            }
            const payload:ChatBlockPayload = {
                v: 1,
                chaId,
                chatId: chatIds[i],
                chat: chats[i]
            };
            encodedChats.push([name, await this.encodeBlock({
                compression: this.compression,
                data: JSON.stringify(payload),
                type: RisuSaveType.CHAT,
                name,
                skipRemoteSaving
            }, blockOption)]);
        }
        const characterData = this.serializeSplitCharacter(character, chatIds);
        //a remote character file that did not change is not written again (only its chats changed)
        const reuseCharacterBlock = plan.remote &&
            previous !== undefined &&
            this.blocks[chaId] !== undefined &&
            this.remoteCharacterContent.get(chaId) === characterData;
        const characterBlock = reuseCharacterBlock ? this.blocks[chaId] : await this.encodeBlock({
            compression: this.compression,
            data: characterData,
            type: RisuSaveType.CHARACTER_WITHOUT_CHAT,
            name: chaId,
            skipRemoteSaving
        }, blockOption);

        //commit
        this.blocks[chaId] = characterBlock;
        if(plan.remote && !skipRemoteSaving){
            this.remoteCharacterContent.set(chaId, characterData);
        }
        else if(!reuseCharacterBlock){
            this.remoteCharacterContent.delete(chaId);
        }
        const current = new Map<string, string>();
        for(let i = 0; i < chatIds.length; i++){
            current.set(chatIds[i], names[i]);
            this.chatBlockOwner.set(names[i], chaId);
        }
        for(const [name, block] of encodedChats){
            this.blocks[name] = block;
        }
        const currentNames = new Set(names);
        for(const name of previous?.values() ?? []){
            if(!currentNames.has(name) && this.chatBlockOwner.get(name) === chaId){
                delete this.blocks[name];
                this.chatBlockOwner.delete(name);
            }
        }
        this.splitChatBlocks.set(chaId, current);
    }

    /** removes every chat block of a character (it was deleted or is saved as a legacy block now) */
    private removeChatBlocks(chaId:string){
        const previous = this.splitChatBlocks.get(chaId);
        if(!previous){
            return;
        }
        for(const name of previous.values()){
            if(this.chatBlockOwner.get(name) === chaId){
                delete this.blocks[name];
                this.chatBlockOwner.delete(name);
            }
        }
        this.splitChatBlocks.delete(chaId);
    }

    /**
     * A character whose chaId equals an existing chat block name would overwrite that block.
     * Save the owner of such a block as a legacy block first (its plan now fails on the collision).
     */
    private async releaseCollidingChatBlocks(data:Database, context:CharacterEncodeContext){
        for(const chaId of context.chaIds){
            const owner = this.chatBlockOwner.get(chaId);
            if(owner === undefined){
                continue;
            }
            const ownerCharacter = data.characters.find((c) => c?.chaId === owner);
            if(ownerCharacter && !context.duplicateChaIds.has(owner)){
                await this.encodeCharacter(ownerCharacter, context, 'all');
            }
            if(this.chatBlockOwner.get(chaId) === owner){
                //owner is not in the database anymore; drop only the colliding block
                delete this.blocks[chaId];
                this.chatBlockOwner.delete(chaId);
                for(const [chatId, name] of this.splitChatBlocks.get(owner) ?? []){
                    if(name === chaId){
                        this.splitChatBlocks.get(owner).delete(chatId);
                    }
                }
            }
        }
    }

    private shouldEncodeRemote(option:EncodeBlockOption){
        return this.allowRemote &&
            (
                option.remote === 'force' ||
                (
                    option.remote === 'prefer' &&
                    (
                        isTauri ||
                        isNodeServer
                    )
                ) &&
                !disableRemoteSaving()
            );
    }

    async encodeBlock(arg:EncodeBlockArg, option:EncodeBlockOption = { remote: 'none' }){
        if(this.shouldEncodeRemote(option)){
            return await this.encodeRemoteBlock(arg);
        }
        return await this.encodeRawBlock(arg);
    }

    async encodeRawBlock(arg:EncodeBlockArg){
        let databuf: Uint8Array;
        const cacheBlock = arg.cache ?? true;
        if(arg.compression){
            await checkCompressionStreams();
            const cs = new CompressionStream('gzip');
            const writer = cs.writable.getWriter();
            writer.write(new TextEncoder().encode(arg.data));
            writer.close();
            const compressedData = await new Response(cs.readable).arrayBuffer();
            databuf = (new Uint8Array(compressedData));
        }
        else{
            databuf = (new TextEncoder().encode(arg.data));
        }
        const nameBuf = new TextEncoder().encode(arg.name);
        const lengthBuf = new ArrayBuffer(4);
        new Uint32Array(lengthBuf)[0] = databuf.length;
        const arrayBuf = new ArrayBuffer(2 + 1 + nameBuf.length + 4 + databuf.length);
        const buf = new Uint8Array(arrayBuf);
        buf.set(new Uint8Array([arg.type, arg.compression ? 1 : 0]), 0);
        buf.set(new Uint8Array([nameBuf.length]), 2);
        buf.set(nameBuf, 3);
        buf.set(new Uint8Array(lengthBuf), 3 + nameBuf.length);
        buf.set(databuf, 7 + nameBuf.length);
        if(this.cacheBlocks && cacheBlock){
            await risuSaveCacheForage.setItem(`risuSaveBlock_${arg.name}`, {
                type: arg.type,
                data: arg.data,
                name: arg.name,
            });
        }
        return buf;
    }

    /** lists the existing remote files (Tauri: the `remotes` folder, otherwise every storage key) */
    private async listRemoteFiles():Promise<Set<string>>{
        try {
            if(isTauri){
                if(!(await exists('remotes', { baseDir: BaseDirectory.AppData }))){
                    return new Set();
                }
                const entries = await readDir('remotes', { baseDir: BaseDirectory.AppData });
                return new Set(entries.map((entry) => `remotes/${entry.name}`));
            }
            return new Set(await forageStorage.keys());
        } catch (error) {
            //unknown means "does not exist": the file is written
            console.error('Could not list remote files:', error);
            return new Set();
        }
    }

    private async remoteFileExists(fileName:string){
        if(this.listingRemoteFiles){
            this.remoteListing ??= this.listRemoteFiles();
            return (await this.remoteListing).has(fileName);
        }
        if(isTauri){
            return await exists(fileName, { baseDir: BaseDirectory.AppData });
        }
        return (await forageStorage.keys()).includes(fileName);
    }

    async encodeRemoteBlock(arg:EncodeBlockArg){
        console.log(`Encoding remote block: ${arg.name}`);
        const encoded = new TextEncoder().encode(arg.data);
        const fileName = remoteFilePath(arg.name)

        if(arg.skipRemoteSaving && checkedRemoteExistence.has(arg.name) === false){
            const fileExists = await this.remoteFileExists(fileName);
            if(!fileExists){
                console.log(`Remote file ${fileName} does not exist, disabling skipRemoteSaving for this block.`);
                arg.skipRemoteSaving = false;
            }
            checkedRemoteExistence.add(arg.name);
        }

        if(!arg.skipRemoteSaving){
            await writeRemoteFile(arg.name, encoded, arg.type === RisuSaveType.CHAT);
        }
        return await this.encodeBlock({
            compression: false,
            data: JSON.stringify({
                v: 1,
                type: arg.type,
                name: arg.name,
            }),
            type: RisuSaveType.REMOTE,
            name: arg.name
        });
    }
}

export class RisuSaveDecoder {
    private blocks: {
        name: string;
        type: RisuSaveType;
        compression: boolean;
        content: string;
    }[] = []
    async decode(data: Uint8Array): Promise<DecodedRisuSave> {
        console.log('Decoding RisuSave data');
        let offset = magicRisuSaveHeader.length;
        //@ts-expect-error Database has required fields, but we initialize empty and populate incrementally during decode
        let db:Database = {}
        const kv: SaveKVData = {}
        const loadedBlocks = new Set<string>();
        while (offset < data.length) {
            try {
                const type = data[offset];
                const compression = data[offset + 1] === 1;
                offset += 2;

                const nameLength = data[offset];
                offset += 1;
                const name = new TextDecoder().decode(data.subarray(offset, offset + nameLength));
                offset += nameLength;

                const newArrayBuf = new ArrayBuffer(4);
                const lengthSubUint8Buf = data.slice(offset, offset + 4);
                new Uint8Array(newArrayBuf).set(lengthSubUint8Buf);
                const length = new Uint32Array(newArrayBuf)[0];
                offset += 4;

                let blockData = data.subarray(offset, offset + length);
                offset += length;

                if (compression) {
                    //decode using DecompressionStream
                    await checkCompressionStreams();
                    const cs = new DecompressionStream('gzip');
                    const writer = cs.writable.getWriter();
                    writer.write(blockData as any);
                    writer.close();
                    const buf = await new Response(cs.readable).arrayBuffer();
                    blockData = new Uint8Array(buf);
                }

                loadedBlocks.add(name);
                this.blocks.push({
                    name,
                    type,
                    compression,
                    content: new TextDecoder().decode(blockData)
                })   
            } catch (error) {
                continue
            }
        }
        console.log('blocks',this.blocks)
        //remote files are read ahead with bounded concurrency; their blocks are still appended in pointer order
        const limitRemoteRead = createLimiter(REMOTE_READ_CONCURRENCY)
        const remoteReads = new Map<object, Promise<string|null>>()
        for(const block of this.blocks){
            if(block.type !== RisuSaveType.REMOTE){
                continue
            }
            try {
                const remoteInfo = JSON.parse(block.content)
                if(typeof remoteInfo?.name === 'string'){
                    const withBackup = remoteInfo.type === RisuSaveType.CHAT
                    remoteReads.set(block, limitRemoteRead(() => readRemotePayload(remoteInfo.name, withBackup)))
                }
            } catch (error) {
                //reported when the block is processed
            }
        }
        let directory: string[] = []
        /** characters saved with CHARACTER_WITHOUT_CHAT + CHAT blocks, in block order */
        const splitCharacters: { character: any, chatIds: string[] }[] = []
        const chatRecords: ChatBlockPayload[] = []
        for(let i = 0; i < this.blocks.length; i++){
            const key = i;
            try {
                switch(this.blocks[key].type){
                    case RisuSaveType.ROOT:{
                        const rootData = JSON.parse(this.blocks[key].content);
                        for(const rootKey in rootData){
                            if(!db[rootKey] && !rootKey.startsWith('__')){
                                db[rootKey] = rootData[rootKey];
                            }
                            if(rootKey === '__directory'){
                                directory = rootData[rootKey];
                                console.log('RisuSave directory:', directory);
                                for(const dirKey of directory){
                                    if(!loadedBlocks.has(dirKey)){
                                        try {
                                            console.log(`Loading directory block ${dirKey} from cache`);
                                            const dirData:{
                                                type:RisuSaveType
                                                data:string
                                                name:string
                                            } = await risuSaveCacheForage.getItem(`risuSaveBlock_${dirKey}`) as any;

                                            if(dirData){
                                                this.blocks.push({
                                                    name: dirData.name,
                                                    type: dirData.type,
                                                    compression: false,
                                                    content: dirData.data
                                                });
                                                loadedBlocks.add(dirKey);
                                            }
                                        } catch (error) {
                                            console.error(`Error loading directory block ${dirKey}:`, error);
                                        }
                                    }
                                }
                            }
                        }
                        break;
                    }
                    case RisuSaveType.CHARACTER_WITH_CHAT:
                    case RisuSaveType.CHARACTER_WITHOUT_CHAT:{
                        db.characters ??= [];
                        const character = JSON.parse(this.blocks[key].content);
                        //a block with a chats array is a full character. The marker is accepted in both types:
                        //a crash between writing a remote character file and database.bin can leave the old pointer type
                        const chatIds = getSplitChatIds(character);
                        if(chatIds){
                            //chats are attached after all blocks are read
                            character.chats = [];
                            splitCharacters.push({ character, chatIds });
                        }
                        db.characters.push(character);
                        break
                    }
                    case RisuSaveType.CHAT:{
                        const payload = parseChatPayload(this.blocks[key].content);
                        if(!payload){
                            console.warn(`Invalid chat block ${this.blocks[key].name}, ignoring.`);
                            break;
                        }
                        chatRecords.push(payload);
                        break;
                    }
                    case RisuSaveType.BOTPRESET:{
                        db.botPresets = JSON.parse(this.blocks[key].content);
                        break;
                    }
                    case RisuSaveType.MODULES:{
                        db.modules = JSON.parse(this.blocks[key].content);
                        break;
                    }
                    case RisuSaveType.CONFIG:{
                        //ignore for now
                        break;
                    }
                    case RisuSaveType.PLUGINS:{
                        db.plugins = JSON.parse(this.blocks[key].content);
                        break;
                    }
                    case RisuSaveType.LOADOUTS:{
                        db.loadouts = JSON.parse(this.blocks[key].content);
                        break;
                    }
                    case RisuSaveType.PLUGIN_STORAGE:{
                        db.pluginCustomStorage = JSON.parse(this.blocks[key].content);
                        break;
                    }
                    case RisuSaveType.KV:{
                        const name = this.blocks[key].name;
                        if(name.startsWith(KV_BLOCK_PREFIX)){
                            kv[name.slice(KV_BLOCK_PREFIX.length)] = JSON.parse(this.blocks[key].content);
                        }
                        break;
                    }
                    case RisuSaveType.REMOTE:{
                        const remoteInfo:{
                            v:number
                            type:RisuSaveType
                            name:string
                        } = JSON.parse(this.blocks[key].content);
                        const fileName = remoteFilePath(remoteInfo.name)
                        //blocks loaded from the block cache were not read ahead
                        const decoded = await (
                            remoteReads.get(this.blocks[key]) ??
                            readRemotePayload(remoteInfo.name, remoteInfo.type === RisuSaveType.CHAT)
                        )
                        if(decoded === null){
                            console.warn(`Remote file ${fileName} not found.`);
                            break;
                        }

                        //add to blocks for further processing (this loop also visits blocks appended here)
                        this.blocks.push({
                            name: remoteInfo.name,
                            type: remoteInfo.type,
                            compression: false,
                            content: decoded
                        });
                        break;
                    }
                    case RisuSaveType.ROOT_COMPONENT:{
                        const componentData:{
                            data:any
                            key:string
                        } = JSON.parse(this.blocks[key].content);
                        db[componentData.key] = componentData.data;
                        break;
                    }
                    default:{
                        console.warn(`Not Implemented RisuSaveType: ${this.blocks[key].type} for ${this.blocks[key].name}`);
                    }
                }   
            } catch (error) {
                console.error(`Error processing block ${this.blocks[key].name}:`, error);

                if(this.blocks[key].type === RisuSaveType.ROOT){
                    throw new Error('Failed to decode root block, cannot proceed with decoding RisuSave data');
                }
            }
        }
        await attachSplitChats(db, splitCharacters, chatRecords, {
            probeRemote: isTauri || isNodeServer,
            limit: limitRemoteRead
        })
        //to fix botpreset bugs
        if(!Array.isArray(db.botPresets) || db.botPresets.length === 0){
            db.botPresets = [presetTemplate]
            db.botPresetsId = 0
        }
        console.log('Decoded RisuSave data', db);
        return { database: db, kv };
    }
}

function parseChatPayload(content:string):ChatBlockPayload|null{
    const payload:ChatBlockPayload = JSON.parse(content)
    if(
        !payload || typeof payload.chaId !== 'string' || typeof payload.chatId !== 'string' ||
        !payload.chat || typeof payload.chat !== 'object' || Array.isArray(payload.chat)
    ){
        return null
    }
    return payload
}

/**
 * Reads the remote files of listed chats that have no decoded block (their pointer may be missing
 * from database.bin after a crash). Only payloads of exactly that chat are accepted.
 */
async function probeRemoteChats(splitCharacters:{ character: any, chatIds: string[] }[], chatRecords:ChatBlockPayload[], limit:ReturnType<typeof createLimiter>){
    const known = new Set(chatRecords.map((r) => JSON.stringify([r.chaId, r.chatId])))
    const probes:{ chaId:string, chatId:string }[] = []
    for(const { character, chatIds } of splitCharacters){
        const chaId = character?.chaId
        if(typeof chaId !== 'string'){
            continue
        }
        for(const chatId of chatIds){
            const key = JSON.stringify([chaId, chatId])
            if(known.has(key) || !isSafeRemoteChat(chaId, chatId)){
                continue
            }
            known.add(key)
            probes.push({ chaId, chatId })
        }
    }
    const results = await Promise.all(probes.map(({ chaId, chatId }) => limit(() => readRemotePayload(chatBlockName(chaId, chatId), true))))
    for(let i = 0; i < probes.length; i++){
        if(results[i] === null){
            continue
        }
        try {
            const payload = parseChatPayload(results[i])
            if(payload && payload.chaId === probes[i].chaId && payload.chatId === probes[i].chatId){
                console.warn(`Recovered chat ${payload.chatId} of character ${payload.chaId} from its file.`)
                chatRecords.push(payload)
            }
        } catch (error) {
            console.error(`Error reading the probed chat ${probes[i].chatId}:`, error)
        }
    }
}

/**
 * Attaches decoded CHAT blocks to their split characters, in the recorded order.
 * Listed chats without a block are looked up as remote files first (probeRemote),
 * then become placeholders. Unlisted chats of an existing character are appended,
 * chats of a character that does not exist are dropped.
 */
async function attachSplitChats(db:Database, splitCharacters:{ character: any, chatIds: string[] }[], chatRecords:ChatBlockPayload[], arg:{
    probeRemote:boolean
    limit:ReturnType<typeof createLimiter>
}){
    if(splitCharacters.length === 0 && chatRecords.length === 0){
        return
    }
    if(arg.probeRemote){
        await probeRemoteChats(splitCharacters, chatRecords, arg.limit)
    }
    const recordsByCharacter = new Map<string, ChatBlockPayload[]>()
    for(const record of chatRecords){
        if(!recordsByCharacter.has(record.chaId)){
            recordsByCharacter.set(record.chaId, [])
        }
        recordsByCharacter.get(record.chaId).push(record)
    }
    const used = new Set<ChatBlockPayload>()
    const takeChat = (record:ChatBlockPayload) => {
        if(used.has(record)){
            //only possible with duplicated chaIds; give each character its own copy
            return JSON.parse(JSON.stringify(record.chat))
        }
        used.add(record)
        return record.chat
    }

    for(const { character, chatIds } of splitCharacters){
        const records = recordsByCharacter.get(character.chaId) ?? []
        const takenHere = new Set<ChatBlockPayload>()
        const chats:any[] = []
        for(const chatId of chatIds){
            const record = records.find((r) => r.chatId === chatId && !takenHere.has(r))
            if(record){
                takenHere.add(record)
                const chat = takeChat(record)
                chat.id ??= chatId
                chats.push(chat)
            }
            else{
                console.error(`Chat block ${chatId} of character ${character.chaId} is missing, inserting a placeholder.`)
                chats.push(makeMissingChatPlaceholder(chatId))
            }
        }
        character.chats = chats
    }

    //chat blocks that are not in the order list of their character
    for(const record of chatRecords){
        if(used.has(record)){
            continue
        }
        const parent = (db.characters ?? []).find((c) => c?.chaId === record.chaId)
        if(!parent){
            console.warn(`Discarding chat ${record.chatId}: character ${record.chaId} does not exist.`)
            continue
        }
        if(!Array.isArray(parent.chats)){
            parent.chats = []
        }
        if(parent.chats.some((c) => c?.id === record.chatId)){
            //a legacy character already holding this chat
            continue
        }
        console.warn(`Recovering chat ${record.chatId} of character ${record.chaId} that is not in its chat list.`)
        used.add(record)
        record.chat.id ??= record.chatId
        parent.chats.push(record.chat)
    }

    for(const { character } of splitCharacters){
        const page = character.chatPage
        if(character.chats.length > 0 && !(Number.isInteger(page) && page >= 0 && page < character.chats.length)){
            character.chatPage = 0
        }
    }
}

export type DecodedRisuSave = {
    database: Database
    /** SaveKV namespaces stored in the save (empty for formats older than RisuSave blocks) */
    kv: SaveKVData
}

/**
 * Decodes any save format. Returns the database and the SaveKV data separately;
 * the caller decides whether they become live (setDatabase + saveKV.load).
 */
export async function decodeRisuSave(data:Uint8Array): Promise<DecodedRisuSave>{
    const header = checkHeader(data)
    if(header === 'risusave'){
        try {
            const decoder = new RisuSaveDecoder();
            return await decoder.decode(data);
        } catch (error) {
            //kept from the original decoder: a failed RisuSave decode still tries the legacy fallbacks
            console.error('Error decoding RisuSave data:', error);
            return { database: await decodeFallback(data), kv: {} }
        }
    }
    return { database: await decodeLegacyRisuSave(data, header), kv: {} }
}

async function decodeLegacyRisuSave(data:Uint8Array, header:ReturnType<typeof checkHeader>){
    try {
        switch(header){
            case "compressed":
                data = data.slice(magicCompressedHeader.length)
                return decode(fflate.decompressSync(data))
            case "raw":
                data = data.slice(magicHeader.length)
                return unpackr.decode(data)
            case "stream":{
                await checkCompressionStreams()
                data = data.slice(magicStreamCompressedHeader.length)
                const cs = new DecompressionStream('gzip');
                const writer = cs.writable.getWriter();
                writer.write(data as any);
                writer.close();
                const buf = await new Response(cs.readable).arrayBuffer()
                return unpackr.decode(new Uint8Array(buf))
            }
        }
        return unpackr.decode(data)
    }
    catch (error) {
        console.error('Error decoding RisuSave data:', error);
        //data may already be sliced past the header here, as before
        return await decodeFallback(data)
    }
}

/** last-resort decoders for older/odd save formats */
async function decodeFallback(data:Uint8Array){
    try {
        console.log('risudecode')
        const risuSaveHeader = new Uint8Array(Buffer.from("\u0000\u0000RISU",'utf-8'))
        const realData = data.subarray(risuSaveHeader.length)
        const dec = unpackr.decode(realData)
        return dec
    } catch (error) {
        const buf = Buffer.from(fflate.decompressSync(Buffer.from(data)))
        try {
            return JSON.parse(buf.toString('utf-8'))
        } catch (error) {
            return unpackr.decode(buf)
        }
    }
}

/**
 * Encodes a complete, self-contained save file in the RisuSave block format (backups, exports, migrations).
 * Never writes remote block files or the local block cache.
 */
export async function encodeRisuSave(data:Database|Record<string, never>, arg:{
    compression?: boolean,
    kv?: SaveKVSource | null
} = {}): Promise<Uint8Array>{
    const encoder = new RisuSaveEncoder({ remote: false, cache: false });
    await encoder.init(data as Database, {
        compression: arg.compression ?? false,
        kv: arg.kv ?? null
    });
    return new Uint8Array(encoder.encode());
}

function checkHeader(data: Uint8Array) {

    let header:'none'|'compressed'|'raw'|'stream'|'risusave' = 'raw'

    if (data.length < magicHeader.length) {
      return false;
    }
  
    for (let i = 0; i < magicHeader.length; i++) {
      if (data[i] !== magicHeader[i]) {
        header = 'none'
        break
      }
    }

    if(header === 'none'){
        header = 'compressed'
        for (let i = 0; i < magicCompressedHeader.length; i++) {
            if (data[i] !== magicCompressedHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'stream'
        for (let i = 0; i < magicStreamCompressedHeader.length; i++) {
            if (data[i] !== magicStreamCompressedHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    if(header === 'none'){
        header = 'risusave'
        for (let i = 0; i < magicRisuSaveHeader.length; i++) {
            if (data[i] !== magicRisuSaveHeader[i]) {
                header = 'none'
                break
            }
        }
    }

    // All bytes matched
    return header;
  }