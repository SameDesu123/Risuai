import { getNodeServerProxyAuth } from "./storage/nodeStorage"

export type CloudflaredMode = 'quick' | 'token'

export interface CloudflaredStatus {
    status: 'stopped' | 'downloading' | 'starting' | 'running' | 'error'
    url: string
    error: string
    mode: CloudflaredMode
    runningMode: CloudflaredMode | ''
    hasToken: boolean
    binaryPath: string
    logs: string[]
}

async function cloudflaredRequest(endpoint: string, body?: Record<string, unknown>): Promise<CloudflaredStatus> {
    const res = await fetch(`/api/cloudflared/${endpoint}`, {
        method: body ? 'POST' : 'GET',
        headers: {
            'content-type': 'application/json',
            'risu-auth': await getNodeServerProxyAuth(),
        },
        body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
        let message = `HTTP ${res.status}`
        try {
            const data = await res.json()
            message = data.error ?? message
        } catch {}
        throw new Error(message)
    }
    return await res.json()
}

export function getCloudflaredStatus() {
    return cloudflaredRequest('status')
}

export function setCloudflaredConfig(config: { mode?: CloudflaredMode, token?: string }) {
    return cloudflaredRequest('config', config)
}

export function startCloudflared() {
    return cloudflaredRequest('start', {})
}

export function stopCloudflared() {
    return cloudflaredRequest('stop', {})
}
