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

/**
 * Parses a /api/read_bulk response: one frame per requested key,
 * [1 byte flag: 0 = missing, 1 = found] then, if found, [uint32 BE length][bytes].
 */
export function parseReadBulkResponse(data:Uint8Array, count:number):(Buffer|null)[] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const results:(Buffer|null)[] = []
    let offset = 0
    for(let i = 0; i < count; i++){
        if(offset + 1 > data.byteLength){
            throw new Error('Node storage getItems received a truncated response')
        }
        const flag = data[offset]
        offset += 1
        if(flag === 0){
            results.push(null)
            continue
        }
        if(flag !== 1 || offset + 4 > data.byteLength){
            throw new Error('Node storage getItems received an invalid response')
        }
        const length = view.getUint32(offset)
        offset += 4
        if(offset + length > data.byteLength){
            throw new Error('Node storage getItems received a truncated response')
        }
        const item = Buffer.from(data.subarray(offset, offset + length))
        offset += length
        // Match getItem, which treats an empty file as missing
        results.push(item.length === 0 ? null : item)
    }
    if(offset !== data.byteLength){
        throw new Error('Node storage getItems received an invalid response')
    }
    return results
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
     * Reads several items with /api/read_bulk, NODE_READ_BULK_MAX_ITEMS keys per request.
     * The result has one entry per key, in the same order; missing items are null.
     */
    async getItems(keys:string[]):Promise<(Buffer|null)[]> {
        await this.checkAuth()
        const results:(Buffer|null)[] = []
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
                throw new Error(`Node storage getItems failed.\nHTTP: ${da.status}` + (responseDetail ? `\nServer: ${responseDetail}` : ''))
            }
            results.push(...parseReadBulkResponse(new Uint8Array(await da.arrayBuffer()), chunk.length))
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
