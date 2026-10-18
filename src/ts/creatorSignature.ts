import type { character } from "./storage/database.svelte"

// Creator signatures prove who authored a card without hiding anything:
// the card stays plaintext, and each signer appends an ECDSA P-256 signature
// over a hash of the card's content. The first entry is the original author,
// later entries are people who modified and re-exported it.

export const CONTENT_HASH_VERSION = 1
export const SIGNING_KEY_FILE_TYPE = 'risu-creator-signing-key'

export interface CreatorSigningKey {
    v: 1
    name: string
    authorId: string
    publicKey: string //base64 SPKI
    privateKey: JsonWebKey
    createdAt: number
}

export interface CreatorSignature {
    v: 1
    alg: 'ES256'
    hv: number
    name: string
    authorId: string
    publicKey: string //base64 SPKI
    contentHash: string
    prev?: string //sig of the previous entry, binds the chain order
    signedAt: number
    sig: string
}

export type SignatureStatus = 'none'|'verified'|'modified'|'invalid'

export interface SignatureVerification {
    status: SignatureStatus
    entries: {
        entry: CreatorSignature
        valid: boolean
    }[]
}

const signableFields = [
    'name', 'desc', 'personality', 'scenario', 'firstMessage', 'alternateGreetings', 'exampleMessage',
    'creatorNotes', 'systemPrompt', 'replaceGlobalNote', 'additionalText', 'backgroundHTML',
    'globalLore', 'customscript', 'triggerscript',
] as const

export type SignableCharacter = Partial<Pick<character, typeof signableFields[number]>>

export function pickSignable(char:SignableCharacter):SignableCharacter{
    const picked:Record<string, unknown> = {}
    for(const field of signableFields){
        picked[field] = char[field]
    }
    return picked as SignableCharacter
}

const ecdsaParams = { name: 'ECDSA', namedCurve: 'P-256' }
const signParams = { name: 'ECDSA', hash: 'SHA-256' }

export function stableStringify(value:unknown):string{
    if(value === null || typeof value !== 'object'){
        return JSON.stringify(value) ?? 'null'
    }
    if(Array.isArray(value)){
        return '[' + value.map((v) => v === undefined ? 'null' : stableStringify(v)).join(',') + ']'
    }
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

async function sha256Hex(data:Uint8Array){
    return Buffer.from(await crypto.subtle.digest('SHA-256', data as BufferSource)).toString('hex')
}

function splitKeys(keys:string|undefined){
    return (keys ?? '').split(',').map((k) => k.trim()).filter((k) => k.length > 0)
}

// The creator notes editor (MultiLangInput) rewrites plain notes into the "# `en`" multi-language
// form as soon as it is opened, so notes are hashed as a language -> text map instead of raw text.
// Mirrors parseMultilangString in util.ts, which is not imported to keep this module dependency free.
function normalizeNotes(notes:string){
    const sections:Record<string, string> = {}
    const rest = notes.replace(/# `(.+?)`\n([\s\S]+?)(?=\n# `|$)/g, (_, lang:string, text:string) => {
        sections[lang] = text
        return ''
    })
    sections.en ??= rest
    const result:Record<string, string> = {}
    for(const lang of Object.keys(sections)){
        const text = sections[lang].trim()
        if(text.length > 0){
            result[lang] = text
        }
    }
    return result
}

// Only fields that survive a V2, V3 and charx export/import round trip unchanged are hashed,
// so re-importing an untouched card still verifies.
function normalizeContent(char:SignableCharacter){
    return {
        name: char.name ?? '',
        desc: char.desc ?? '',
        personality: char.personality ?? '',
        scenario: char.scenario ?? '',
        firstMessage: char.firstMessage ?? '',
        alternateGreetings: char.alternateGreetings ?? [],
        exampleMessage: char.exampleMessage ?? '',
        creatorNotes: normalizeNotes(char.creatorNotes ?? ''),
        systemPrompt: char.systemPrompt ?? '',
        replaceGlobalNote: char.replaceGlobalNote ?? '',
        additionalText: char.additionalText ?? '',
        backgroundHTML: char.backgroundHTML ?? '',
        lorebook: (char.globalLore ?? []).map((lore) => ({
            key: splitKeys(lore.key),
            secondkey: lore.selective ? splitKeys(lore.secondkey) : [],
            content: lore.content ?? '',
            comment: lore.comment ?? '',
            alwaysActive: lore.alwaysActive ?? false,
            selective: lore.selective ?? false,
            insertorder: lore.insertorder ?? 0,
            mode: lore.mode ?? 'normal',
            folder: lore.folder ?? '',
        })),
        regex: (char.customscript ?? []).map((script) => ({
            comment: script.comment ?? '',
            in: script.in ?? '',
            out: script.out ?? '',
            type: script.type ?? '',
            flag: script.flag ?? '',
            ableFlag: script.ableFlag ?? false,
        })),
        //lowLevelAccess is overwritten on trigger objects at runtime, so it is not content
        triggers: (char.triggerscript ?? []).map(({ lowLevelAccess, ...trigger }) => trigger),
    }
}

export async function computeContentHash(char:SignableCharacter, hv:number = CONTENT_HASH_VERSION):Promise<string|null>{
    if(hv !== 1){
        return null
    }
    return sha256Hex(new TextEncoder().encode(stableStringify(normalizeContent(char))))
}

export async function fingerprint(publicKey:string){
    const hex = await sha256Hex(Buffer.from(publicKey, 'base64'))
    return hex.slice(0, 16).match(/.{4}/g).join('-')
}

function signaturePayload(entry:Omit<CreatorSignature, 'sig'>){
    return new TextEncoder().encode(stableStringify({
        v: entry.v,
        alg: entry.alg,
        hv: entry.hv,
        name: entry.name,
        authorId: entry.authorId,
        publicKey: entry.publicKey,
        contentHash: entry.contentHash,
        prev: entry.prev,
        signedAt: entry.signedAt,
    }))
}

async function signPayload(privateKey:JsonWebKey, payload:Uint8Array){
    const key = await crypto.subtle.importKey('jwk', privateKey, ecdsaParams, false, ['sign'])
    return Buffer.from(await crypto.subtle.sign(signParams, key, payload as BufferSource)).toString('base64')
}

async function verifyPayload(publicKey:string, sig:string, payload:Uint8Array){
    try {
        const key = await crypto.subtle.importKey('spki', Buffer.from(publicKey, 'base64'), ecdsaParams, false, ['verify'])
        return await crypto.subtle.verify(signParams, key, Buffer.from(sig, 'base64'), payload as BufferSource)
    } catch {
        return false
    }
}

function isSignature(value:unknown):value is CreatorSignature{
    const entry = value as CreatorSignature
    return !!entry && typeof entry === 'object'
        && entry.v === 1
        && entry.alg === 'ES256'
        && typeof entry.hv === 'number'
        && typeof entry.name === 'string'
        && typeof entry.authorId === 'string'
        && typeof entry.publicKey === 'string'
        && typeof entry.contentHash === 'string'
        && (entry.prev === undefined || typeof entry.prev === 'string')
        && typeof entry.signedAt === 'number'
        && typeof entry.sig === 'string'
}

export async function generateSigningKey(name:string):Promise<CreatorSigningKey>{
    const pair = await crypto.subtle.generateKey(ecdsaParams, true, ['sign', 'verify'])
    const publicKey = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')
    return {
        v: 1,
        name: name,
        authorId: await fingerprint(publicKey),
        publicKey: publicKey,
        privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
        createdAt: Date.now(),
    }
}

export function exportSigningKeyFile(key:CreatorSigningKey){
    return JSON.stringify({ type: SIGNING_KEY_FILE_TYPE, ...key }, null, 2)
}

export async function parseSigningKeyFile(text:string):Promise<CreatorSigningKey>{
    const data = JSON.parse(text)
    if(data?.type !== SIGNING_KEY_FILE_TYPE || data.v !== 1 || typeof data.publicKey !== 'string'
        || !data.privateKey || typeof data.privateKey !== 'object'){
        throw new Error('Invalid creator signing key file')
    }
    const probe = new TextEncoder().encode(SIGNING_KEY_FILE_TYPE)
    const sig = await signPayload(data.privateKey, probe).catch(() => '')
    if(!sig || !(await verifyPayload(data.publicKey, sig, probe))){
        throw new Error('Creator signing key file has mismatched keys')
    }
    return {
        v: 1,
        name: typeof data.name === 'string' ? data.name : '',
        authorId: await fingerprint(data.publicKey),
        publicKey: data.publicKey,
        privateKey: data.privateKey,
        createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
    }
}

export async function verifyChain(chain:unknown, char:SignableCharacter):Promise<SignatureVerification>{
    if(!Array.isArray(chain) || chain.length === 0){
        return { status: 'none', entries: [] }
    }
    const entries:SignatureVerification['entries'] = []
    let allValid = true
    let prevSig:string|undefined = undefined
    for(const entry of chain){
        if(!isSignature(entry)){
            allValid = false
            prevSig = undefined
            continue
        }
        const valid = entry.prev === prevSig
            && (await fingerprint(entry.publicKey)) === entry.authorId
            && (await verifyPayload(entry.publicKey, entry.sig, signaturePayload(entry)))
        entries.push({ entry, valid })
        allValid &&= valid
        prevSig = entry.sig
    }
    if(!allValid){
        return { status: 'invalid', entries }
    }
    const last = entries[entries.length - 1].entry
    const currentHash = await computeContentHash(char, last.hv)
    return { status: currentHash === last.contentHash ? 'verified' : 'modified', entries }
}

// Returns the chain to embed on export. Unchanged content keeps the chain as is,
// a signer re-signing their own latest entry replaces it, anyone else is appended.
// A chain that fails verification carries no trustworthy authorship, so it is dropped.
export async function signChain(chain:CreatorSignature[]|undefined, char:SignableCharacter, key:CreatorSigningKey):Promise<CreatorSignature[]>{
    const contentHash = await computeContentHash(char)
    const verification = await verifyChain(chain, char)
    let base = verification.status === 'invalid' ? [] : verification.entries.map((e) => e.entry)
    const last = base[base.length - 1]
    if(last && last.hv === CONTENT_HASH_VERSION && last.contentHash === contentHash){
        return base
    }
    if(last && last.authorId === key.authorId){
        base = base.slice(0, -1)
    }
    const unsigned:Omit<CreatorSignature, 'sig'> = {
        v: 1,
        alg: 'ES256',
        hv: CONTENT_HASH_VERSION,
        name: key.name,
        authorId: key.authorId,
        publicKey: key.publicKey,
        contentHash: contentHash,
        prev: base[base.length - 1]?.sig,
        signedAt: Math.floor(Date.now() / 1000),
    }
    if(unsigned.prev === undefined){
        delete unsigned.prev
    }
    const entry:CreatorSignature = {
        ...unsigned,
        sig: await signPayload(key.privateKey, signaturePayload(unsigned)),
    }
    return [...base, entry]
}
