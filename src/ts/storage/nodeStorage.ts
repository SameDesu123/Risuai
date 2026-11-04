import { language } from "src/lang"
import { alertError, alertInput, waitAlert } from "../alert"
import { base64url, getKeypairStore, saveKeypairStore } from "../util"

const MAX_STORAGE_ERROR_DETAIL_LENGTH = 2000

function formatStorageValueSize(byteLength:number) {
    if(byteLength < 1024){
        return `${byteLength} bytes`
    }

    const units = ['KiB', 'MiB', 'GiB']
    let size = byteLength
    let unitIndex = -1
    do {
        size /= 1024
        unitIndex += 1
    } while(size >= 1024 && unitIndex < units.length - 1)

    return `${byteLength} bytes (${size.toFixed(2)} ${units[unitIndex]})`
}

function formatUnknownError(error:unknown) {
    if(error instanceof Error){
        return error.message
    }
    if(typeof error === 'string'){
        return error
    }
    try {
        return JSON.stringify(error) ?? `${error}`
    } catch {
        return `${error}`
    }
}

function normalizeStorageErrorDetail(detail:string) {
    const normalized = detail
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s+/g, '\n')
        .trim()

    if(normalized.length <= MAX_STORAGE_ERROR_DETAIL_LENGTH){
        return normalized
    }
    return normalized.slice(0, MAX_STORAGE_ERROR_DETAIL_LENGTH) + '...'
}

async function getStorageResponseErrorDetail(response:Response) {
    let responseText = ''
    try {
        responseText = await response.text()
    } catch (error) {
        return `Could not read the server response: ${formatUnknownError(error)}`
    }

    if(!responseText.trim()){
        return ''
    }

    try {
        const body = JSON.parse(responseText)
        if(body && typeof body === 'object'){
            const details = [body.error, body.code, body.message, body.details]
                .filter((value, index, values) => value != null && value !== '' && values.indexOf(value) === index)
                .map((value) => formatUnknownError(value))
            if(details.length > 0){
                return normalizeStorageErrorDetail(details.join(' | '))
            }
        }
    } catch {}

    return normalizeStorageErrorDetail(responseText)
}

function getSetItemContext(key:string, byteLength:number) {
    return `Key: ${key}\nSize: ${formatStorageValueSize(byteLength)}`
}


/** Must match READ_BULK_MAX_ITEMS in server/node/server.cjs */
export const NODE_READ_BULK_MAX_ITEMS = 100

/** Reads exact byte counts from a ReadableStream, across chunk boundaries */
class StreamByteReader {
    private chunk:Uint8Array = new Uint8Array(0)
    private offset = 0
    private done = false

    constructor(private reader:ReadableStreamDefaultReader<Uint8Array>){}

    private async fill():Promise<boolean> {
        while(this.offset >= this.chunk.byteLength){
            if(this.done){
                return false
            }
            const result = await this.reader.read()
            if(result.done){
                this.done = true
                return false
            }
            this.chunk = result.value
            this.offset = 0
        }
        return true
    }

    /**
     * Returns a new array with exactly n bytes, or null if the stream ended before
     * the first byte. Throws if the stream ends partway through.
     */
    async readExact(n:number):Promise<Uint8Array|null> {
        const out = new Uint8Array(n)
        let written = 0
        while(written < n){
            if(!await this.fill()){
                if(written === 0){
                    return null
                }
                throw new Error('Node storage read_bulk received a truncated response')
            }
            const take = Math.min(n - written, this.chunk.byteLength - this.offset)
            out.set(this.chunk.subarray(this.offset, this.offset + take), written)
            this.offset += take
            written += take
        }
        return out
    }
}

/**
 * Parses a /api/read_bulk response stream, yielding one item per key as soon as it arrives.
 * Each frame is [1 byte flag: 0 = missing, 1 = found] then, if found, [uint32 BE length][bytes].
 */
export async function* parseReadBulkStream(
    stream:ReadableStream<Uint8Array>|null,
    keys:string[]
):AsyncGenerator<{ key:string, data:Buffer|null }> {
    if(!stream){
        if(keys.length > 0){
            throw new Error('Node storage read_bulk received a truncated response')
        }
        return
    }
    const reader = stream.getReader()
    const bytes = new StreamByteReader(reader)
    let finished = false
    try {
        for(const key of keys){
            const flag = await bytes.readExact(1)
            if(!flag){
                throw new Error('Node storage read_bulk received a truncated response')
            }
            if(flag[0] === 0){
                yield { key, data: null }
                continue
            }
            if(flag[0] !== 1){
                throw new Error('Node storage read_bulk received an invalid response')
            }
            const lengthBytes = await bytes.readExact(4)
            if(!lengthBytes){
                throw new Error('Node storage read_bulk received a truncated response')
            }
            const length = new DataView(lengthBytes.buffer).getUint32(0)
            const item = length === 0 ? new Uint8Array(0) : await bytes.readExact(length)
            if(!item){
                throw new Error('Node storage read_bulk received a truncated response')
            }
            // Match getItem, which treats an empty file as missing
            yield { key, data: item.byteLength === 0 ? null : Buffer.from(item.buffer, item.byteOffset, item.byteLength) }
        }
        if(await bytes.readExact(1)){
            throw new Error('Node storage read_bulk received an invalid response')
        }
        finished = true
    } finally {
        if(!finished){
            // Stops the download when the consumer stops early or parsing fails
            await reader.cancel().catch(() => {})
        }
        reader.releaseLock()
    }
}

export class NodeStorage{

    authChecked = false
    JSONStringlifyAndbase64Url(obj:any){
        return base64url(Buffer.from(JSON.stringify(obj), 'utf-8'))
    }

    async createAuth(){
        const keyPair = await this.getKeyPair()
        const date = Math.floor(Date.now() / 1000)
        
        const header = {
            alg: "ES256",
            typ: "JWT",   
        }
        const payload = {
            iat: date,
            exp: date + 5 * 60, //5 minutes expiration
            pub: await crypto.subtle.exportKey('jwk', keyPair.publicKey)
        }
        const sig = await crypto.subtle.sign(
            {
                name: "ECDSA",
                hash: "SHA-256"
            },
            keyPair.privateKey,
            Buffer.from(
                this.JSONStringlifyAndbase64Url(header) + "." + this.JSONStringlifyAndbase64Url(payload)
            )
        )
        const sigString = base64url(new Uint8Array(sig))
        return this.JSONStringlifyAndbase64Url(header) + "." + this.JSONStringlifyAndbase64Url(payload) + "." + sigString
    }

    async getProxyAuth() {
        await this.checkAuth()
        const auth = await this.createAuth()
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('risuauth', auth)
        }
        return auth
    }

    async getKeyPair():Promise<CryptoKeyPair>{
        
        const storedKey = await getKeypairStore('node')

        if(storedKey){
            return storedKey
        }

        const keyPair = await crypto.subtle.generateKey(
            {
                name: "ECDSA",
                namedCurve: "P-256"
            },
            false,
            ["sign", "verify"],
        );

        await saveKeypairStore('node', keyPair)

        return keyPair

    }

    async setItem(key:string, value:Uint8Array) {
        await this.checkAuth()
        const context = getSetItemContext(key, value.byteLength)
        let response:Response
        try {
            response = await fetch('/api/write', {
                method: "POST",
                body: value as any,
                headers: {
                    'content-type': 'application/octet-stream',
                    'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                    'risu-auth': await this.createAuth()
                }
            })
        } catch (error) {
            throw new Error(`Node storage setItem request failed.\n${context}\nCause: ${formatUnknownError(error)}`)
        }

        if(!response.ok){
            const responseDetail = await getStorageResponseErrorDetail(response)
            const httpStatus = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
            throw new Error(
                `Node storage setItem failed.\n${context}\nHTTP: ${httpStatus}` +
                (responseDetail ? `\nServer: ${responseDetail}` : '')
            )
        }

        let data:any
        try {
            data = await response.json()
        } catch (error) {
            throw new Error(`Node storage setItem received an invalid response.\n${context}\nCause: ${formatUnknownError(error)}`)
        }
        if(data.error){
            throw new Error(`Node storage setItem failed.\n${context}\nServer: ${formatUnknownError(data.error)}`)
        }
    }
    async getItem(key:string):Promise<Buffer> {
        await this.checkAuth()
        const da = await fetch('/api/read', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "getItem Error"
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length == 0){
            return null
        }
        return data
    }
    /**
     * Streams items from /api/read_bulk, NODE_READ_BULK_MAX_ITEMS keys per request, in key order.
     * Each item is yielded as soon as it arrives, so only one item needs to be held in memory.
     * Missing or empty items are yielded with data null.
     */
    async *iterItems(keys:string[]):AsyncGenerator<{ key:string, data:Buffer|null }> {
        await this.checkAuth()
        for(let i = 0; i < keys.length; i += NODE_READ_BULK_MAX_ITEMS){
            const chunk = keys.slice(i, i + NODE_READ_BULK_MAX_ITEMS)
            const da = await fetch('/api/read_bulk', {
                method: "POST",
                body: JSON.stringify({
                    paths: chunk.map((key) => Buffer.from(key, 'utf-8').toString('hex'))
                }),
                headers: {
                    'content-type': 'application/json',
                    'risu-auth': await this.createAuth()
                }
            })
            if(da.status < 200 || da.status >= 300){
                const responseDetail = await getStorageResponseErrorDetail(da)
                throw new Error(`Node storage read_bulk failed.\nHTTP: ${da.status}` + (responseDetail ? `\nServer: ${responseDetail}` : ''))
            }
            yield* parseReadBulkStream(da.body, chunk)
        }
    }

    /** Reads several items at once. The result follows the order of keys; missing items are null. */
    async getItems(keys:string[]):Promise<(Buffer|null)[]> {
        const results:(Buffer|null)[] = []
        for await (const { data } of this.iterItems(keys)){
            results.push(data)
        }
        return results
    }
    async keys():Promise<string[]>{
        await this.checkAuth()
        const da = await fetch('/api/list', {
            method: "GET",
            headers:{
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "listItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
        return data.content
    }
    async removeItem(key:string|string[]){
        await this.checkAuth()
        const da = await fetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(Array.isArray(key) ? key.join('$$') : key, 'utf-8').toString('hex'),
                'risu-auth': await this.createAuth()
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "removeItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }

    private async checkAuth(){

        if(!this.authChecked){
            const data = await (await fetch('/api/test_auth',{
                headers: {
                    'risu-auth': await this.createAuth()
                }
            })).json()

            if(data.status === 'unset'){
                const setupToken = new URLSearchParams(location.hash.slice(1)).get('setup')
                if(!setupToken){
                    alertError(language.nodeSetupLinkRequired)
                    await waitAlert()
                    throw language.nodeSetupLinkRequired
                }
                const input = await digestPassword(await alertInput(language.setNodePassword))
                const s = await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input,
                        setupToken: setupToken
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })
                if(s.status < 200 || s.status >= 300){
                    let message = `Password setup failed (${s.status})`
                    try {
                        const body = await s.json()
                        if(body?.error){
                            message = body.error
                        }
                    } catch {}
                    alertError(message)
                    await waitAlert()
                    throw message
                }
                history.replaceState(null, '', location.pathname + location.search)
                return await this.createAuth()
            }
            else if(data.status === 'incorrect'){
                const keypair = await this.getKeyPair()
                const publicKey = await crypto.subtle.exportKey('jwk', keypair.publicKey)
                const input = await digestPassword(await alertInput(language.inputNodePassword))

                const s = await fetch('/api/login',{
                    method: "POST",
                    body: JSON.stringify({
                        password: input,
                        publicKey: publicKey
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })
                if(s.status < 200 || s.status >= 300){
                    let message = `Login failed (${s.status})`
                    try {
                        const body = await s.json()
                        if(body?.error){
                            message = body.error
                        }
                    } catch {}
                    alertError(message)
                    await waitAlert()
                    throw message
                }
                this.authChecked = true
                return await this.createAuth()
            
            }
            else{
                this.authChecked = true
            }
        }
    }

    listItem = this.keys
}

const sharedNodeStorage = new NodeStorage()

export async function getNodeServerProxyAuth() {
    return await sharedNodeStorage.getProxyAuth()
}

async function digestPassword(message:string) {
    const response = await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })

    if(response.status < 200 || response.status >= 300){
        let message = `Password crypto failed (${response.status})`
        try {
            const body = await response.json()
            if(body?.error){
                message = body.error
            }
        } catch {}
        throw message
    }
    const crypt = await response.text()
    
    return crypt;
}
