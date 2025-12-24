import { language } from "src/lang"
import { alertInput } from "../alert"

let auth:string = null
let authChecked = false

export class NodeStorage{
    async setItem(key:string, value:Uint8Array) {
        await this.checkAuth()
        const da = await fetch('/api/write', {
            method: "POST",
            body: value as any,
            headers: {
                'content-type': 'application/octet-stream',
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': auth
            }
        })
        if(da.status < 200 || da.status >= 300){
            throw "setItem Error"
        }
        const data = await da.json()
        if(data.error){
            throw data.error
        }
    }
    async getItem(key:string):Promise<Buffer> {
        await this.checkAuth()
        const da = await fetch('/api/read', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': auth
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
    async keys():Promise<string[]>{
        await this.checkAuth()
        const da = await fetch('/api/list', {
            method: "GET",
            headers:{
                'risu-auth': auth
            }
        })
        const data = await da.json()
        if(da.status < 200 || da.status >= 300){
            throw "listItem Error"
        }
        if(data.error){
            throw data.error
        }
        return data.content
    }
    async removeItem(key:string){
        await this.checkAuth()
        const da = await fetch('/api/remove', {
            method: "GET",
            headers: {
                'file-path': Buffer.from(key, 'utf-8').toString('hex'),
                'risu-auth': auth
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
        if(!auth){
            auth = localStorage.getItem('risuauth')
        }

        if(!authChecked){
            const data = await (await fetch('/api/password',{
                headers: {
                    'risu-auth': auth ?? ''
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
                auth = input
                localStorage.setItem('risuauth', auth)
            }
            else if(data.status === 'incorrect'){
                while(true){
                    const input = await digestPassword(await alertInput(language.inputNodePassword))
                    const data = await (await fetch('/api/password',{
                        headers: {
                            'risu-auth': input ?? ''
                        }
                    })).json()
                    if(data.status !== 'unset'){
                        auth = input
                        localStorage.setItem('risuauth', auth)
                        await this.checkAuth()
                        break
                    }
                }
            }
            else{
                authChecked = true
            }
        }
    }

    /**
     * Sync only changed blocks to server
     * @param changedBlocks Changed block map (blockName -> encoded block data)
     * @param deletedBlocks Array of deleted block names
     */
    async syncBlocks(changedBlocks: Map<string, Uint8Array>, deletedBlocks: string[]): Promise<{success: boolean, size?: number}> {
        await this.checkAuth()
        
        // Convert Uint8Array to base64
        const blocksObject: Record<string, string> = {}
        for (const [name, data] of changedBlocks) {
            // Encode Uint8Array to base64
            let binary = ''
            const bytes = new Uint8Array(data)
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i])
            }
            blocksObject[name] = btoa(binary)
        }

        const response = await fetch('/api/sync-blocks', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'risu-auth': auth
            },
            body: JSON.stringify({
                blocks: blocksObject,
                deleted: deletedBlocks
            })
        })

        if (response.status < 200 || response.status >= 300) {
            throw new Error('syncBlocks failed')
        }

        const data = await response.json()
        if (data.error) {
            throw new Error(data.error)
        }

        return {
            success: data.success,
            size: data.size
        }
    }

    listItem = this.keys
}

async function digestPassword(message:string) {
    const crypt = await (await fetch('/api/crypto', {
        body: JSON.stringify({
            data: message
        }),
        headers: {
            'content-type': 'application/json'
        },
        method: "POST"
    })).text()
    
    return crypt;
}