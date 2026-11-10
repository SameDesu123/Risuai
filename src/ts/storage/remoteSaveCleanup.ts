export const remoteSavePayloadExtension = '.local.bin'
export const remoteSaveBackupSuffix = '.bak'
export const remoteSaveTempSuffix = '.tmp'
export const remoteSaveCorruptMarker = '.corrupt-'
export const remoteSaveMetaSuffix = '.meta'
export const remoteSaveCleanupGraceMs = 1000 * 60 * 60 * 24 * 7

/** prefix of the block name (and remote file stem) of a chat saved as its own block */
export const remoteSaveChatPrefix = 'chat-'

export type RemoteSaveCleanupAction = 'ignore' | 'keep' | 'create-meta' | 'delete'

/**
 * - payload: `X.local.bin`
 * - backup: `X.local.bin.bak` (previous version of a chat file)
 * - temp: `X.local.bin.tmp` (left over by an interrupted write)
 * - corrupt: `X.local.bin.corrupt-<time>` (a chat file that did not parse, never deleted automatically)
 * - meta: `X.local.bin.meta` (cleanup bookkeeping of X)
 */
export type RemoteSaveFileKind = 'payload' | 'backup' | 'temp' | 'corrupt' | 'meta' | 'other'

/** name of the block (and remote file stem) of a chat saved as its own block */
export function getRemoteChatPayloadName(chaId:string, chatId:string){
    return `${remoteSaveChatPrefix}${chaId}-${chatId}`
}

export function parseRemoteSaveFileName(fileName:string):{ kind:RemoteSaveFileKind, payloadName:string|null }{
    const corruptIndex = fileName.lastIndexOf(remoteSavePayloadExtension + remoteSaveCorruptMarker)
    if(corruptIndex > 0){
        return { kind: 'corrupt', payloadName: fileName.slice(0, corruptIndex) }
    }
    const suffixes:[string, RemoteSaveFileKind][] = [
        [remoteSavePayloadExtension, 'payload'],
        [remoteSavePayloadExtension + remoteSaveBackupSuffix, 'backup'],
        [remoteSavePayloadExtension + remoteSaveTempSuffix, 'temp'],
        [remoteSavePayloadExtension + remoteSaveMetaSuffix, 'meta'],
    ]
    for(const [suffix, kind] of suffixes){
        if(fileName.endsWith(suffix) && fileName.length > suffix.length){
            return { kind, payloadName: fileName.slice(0, -suffix.length) }
        }
    }
    return { kind: 'other', payloadName: null }
}

export function getRemoteSavePayloadName(fileName:string){
    const parsed = parseRemoteSaveFileName(fileName)
    return parsed.kind === 'payload' ? parsed.payloadName : null
}

/** meta file that decides the cleanup of a payload name (shared by its main file and its .bak) */
export function getRemoteSaveMetaFileName(payloadName:string){
    return payloadName + remoteSavePayloadExtension + remoteSaveMetaSuffix
}

/** every remote payload name the database still uses: chaIds, and the chat file of every chat with a string id */
export function getActiveRemotePayloadNames(characters:readonly any[]|null|undefined){
    const names = new Set<string>()
    for(const character of characters ?? []){
        const chaId = character?.chaId
        if(typeof chaId !== 'string'){
            continue
        }
        names.add(chaId)
        if(!Array.isArray(character.chats)){
            continue
        }
        for(const chat of character.chats){
            if(typeof chat?.id === 'string'){
                names.add(getRemoteChatPayloadName(chaId, chat.id))
            }
        }
    }
    return names
}

/** cleanup decision for a payload name that is no longer active */
export function getInactiveRemoteSaveAction(arg:{
    hasMeta:boolean
    metaLastUsed?:unknown
    now?:number
}):Exclude<RemoteSaveCleanupAction, 'ignore'>{
    if(!arg.hasMeta){
        return 'create-meta'
    }
    if(
        typeof arg.metaLastUsed === 'number' &&
        Number.isFinite(arg.metaLastUsed) &&
        (arg.now ?? Date.now()) - arg.metaLastUsed > remoteSaveCleanupGraceMs
    ){
        return 'delete'
    }
    return 'keep'
}

/**
 * Decision for a single file. A .bak follows its main file (the meta of the main file decides),
 * .tmp files are deleted right away, .corrupt-* and .meta files are never deleted by themselves.
 */
export function getRemoteSaveCleanupAction(arg:{
    fileName:string
    activeCharacterIds:Set<string>
    hasMeta:boolean
    metaLastUsed?:unknown
    now?:number
}):RemoteSaveCleanupAction{
    const { kind, payloadName } = parseRemoteSaveFileName(arg.fileName)
    if(kind === 'temp'){
        return 'delete'
    }
    if(kind !== 'payload' && kind !== 'backup'){
        return 'ignore'
    }
    if(arg.activeCharacterIds.has(payloadName)){
        return 'keep'
    }
    return getInactiveRemoteSaveAction(arg)
}

export type RemoteSaveCleanupPlan = {
    /** files to delete now (temp files of interrupted writes) */
    deleteNow:string[]
    /**
     * payload names that are no longer active. `files` are the main file and/or its .bak,
     * all deleted together (with the meta file) once getInactiveRemoteSaveAction says so.
     */
    inactive:{
        payloadName:string
        files:string[]
        metaFile:string
        hasMeta:boolean
    }[]
}

/** plans the cleanup of the `remotes` folder from its file names (without the folder) */
export function planRemoteSaveCleanup(fileNames:readonly string[], activePayloadNames:Set<string>):RemoteSaveCleanupPlan{
    const all = new Set(fileNames)
    const deleteNow:string[] = []
    const groups = new Map<string, string[]>()
    for(const fileName of fileNames){
        const { kind, payloadName } = parseRemoteSaveFileName(fileName)
        if(kind === 'temp'){
            deleteNow.push(fileName)
            continue
        }
        if(kind !== 'payload' && kind !== 'backup'){
            continue
        }
        if(activePayloadNames.has(payloadName)){
            continue
        }
        if(!groups.has(payloadName)){
            groups.set(payloadName, [])
        }
        groups.get(payloadName).push(fileName)
    }
    const inactive:RemoteSaveCleanupPlan['inactive'] = []
    for(const [payloadName, files] of groups){
        const metaFile = getRemoteSaveMetaFileName(payloadName)
        inactive.push({ payloadName, files, metaFile, hasMeta: all.has(metaFile) })
    }
    return { deleteNow, inactive }
}
