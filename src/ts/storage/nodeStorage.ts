import { language } from "src/lang"
import { alertError, alertInput, waitAlert } from "../alert"
import { base64url, getKeypairStore, saveKeypairStore, sleep } from "../util"

const MAX_STORAGE_ERROR_DETAIL_LENGTH = 2000
//storage routes are rate limited per IP; a request that hits the limit waits it out this many times
const RATE_LIMIT_RETRIES = 3
const RATE_LIMIT_MAX_WAIT = 60 * 1000
const RATE_LIMIT_DEFAULT_WAIT = 5 * 1000
export const READ_BATCH_MAX_ITEMS = 100
const READ_BATCH_MISSING = 0
const READ_BATCH_FOUND = 1
const READ_BATCH_LEFT_OUT = 2

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

/**
 * Fetches a storage route, waiting for the server's Retry-After when it is rate
 * limited. `init` runs again for each attempt so the auth token stays fresh.
 */
async function fetchStorageRoute(url:string, init:() => Promise<RequestInit>) {
    for(let attempt = 0; ; attempt++){
        const response = await fetch(url, await init())
        if(response.status !== 429 || attempt >= RATE_LIMIT_RETRIES){
            return response
        }
        const retryAfter = Number(response.headers.get('Retry-After'))
        await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, RATE_LIMIT_MAX_WAIT) : RATE_LIMIT_DEFAULT_WAIT)
    }
}

/**
 * Splits a /api/read_batch response into one result per requested key:
 * the data, null if it does not exist, or undefined if the server left it out.
 */
function parseReadBatch(bytes:Uint8Array, count:number) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const results:(Buffer | null | undefined)[] = []
    let offset = 0
    for(let i = 0; i < count; i++){
        if(offset + 5 > bytes.byteLength){
            throw new Error('Node storage read_batch response ended early')
        }
        const status = view.getUint8(offset)
        const length = view.getUint32(offset + 1, true)
        offset += 5
        if(offset + length > bytes.byteLength){
            throw new Error('Node storage read_batch response ended early')
        }
        if(status === READ_BATCH_FOUND){
            //an empty file reads as missing, like getItem
            results.push(length > 0 ? Buffer.from(bytes.buffer, bytes.byteOffset + offset, length) : null)
        }
        else if(status === READ_BATCH_MISSING){
            results.push(null)
        }
        else if(status === READ_BATCH_LEFT_OUT){
            results.push(undefined)
        }
        else{
            throw new Error(`Node storage read_batch response has an unknown status ${status}`)
        }
        offset += length
    }
    if(offset !== bytes.byteLength){
        throw new Error('Node storage read_batch response is longer than expected')
    }
    return results
}

function getSetItemContext(key:string, byteLength:number) {
    return `Key: ${key}\nSize: ${formatStorageValueSize(byteLength)}`
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
            response = await fetchStorageRoute('/api/write', async () => ({
                method: "POST",
                body: value as any,
                headers: {
                    'content-type': 'application/octet-stream',
                    'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                    'risu-auth': await this.createAuth()
                }
            }))
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
        const da = await fetchStorageRoute('/api/read', async () => ({
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': await this.createAuth()
            }
        }))
        if(da.status < 200 || da.status >= 300){
            throw "getItem Error"
        }

        const data = Buffer.from(await da.arrayBuffer())
        if (data.length == 0){
            return null
        }
        return data
    }
    //servers from before /api/read_batch
    batchUnsupported = false

    /**
     * Reads up to READ_BATCH_MAX_ITEMS keys in one request. Each result is the
     * data, null if the key does not exist, or undefined if it was not sent,
     * either because the response was already large or because the server
     * does not support batch reads; read those with getItem.
     */
    async readBatch(keys:string[]):Promise<(Buffer | null | undefined)[]> {
        if(keys.length === 0 || keys.length > READ_BATCH_MAX_ITEMS){
            throw new Error(`readBatch takes 1 to ${READ_BATCH_MAX_ITEMS} keys`)
        }
        if(this.batchUnsupported){
            return keys.map(() => undefined)
        }
        await this.checkAuth()
        const body = JSON.stringify({
            paths: keys.map((key) => Buffer.from(key, 'utf-8').toString('hex'))
        })
        const da = await fetchStorageRoute('/api/read_batch', async () => ({
            method: "POST",
            body,
            headers: {
                'content-type': 'application/json',
                'risu-auth': await this.createAuth()
            }
        }))
        if(da.status === 404){
            this.batchUnsupported = true
            return keys.map(() => undefined)
        }
        if(da.status < 200 || da.status >= 300){
            throw new Error(`Node storage read_batch failed with HTTP ${da.status}`)
        }
        return parseReadBatch(new Uint8Array(await da.arrayBuffer()), keys.length)
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
                const input = await digestPassword(await alertInput(language.setNodePassword))
                await fetch('/api/set_password',{
                    method: "POST",
                    body:JSON.stringify({
                        password: input 
                    }),
                    headers: {
                        'content-type': 'application/json'
                    }
                })
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
