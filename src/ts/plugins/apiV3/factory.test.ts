import { beforeAll, describe, expect, it, vi } from 'vitest'
import { SandboxHost } from './factory'

// Wires a host to a fake iframe that records outgoing messages but never replies,
// like an iframe whose plugin is stuck or already gone.
const createHost = () => {
    const host = new SandboxHost({})
    const postMessage = vi.fn()
    ;(host as any).iframe = {
        contentWindow: { postMessage },
        remove: vi.fn(),
    }
    const getCallback = (id: string) =>
        (host as any).deserializeArgs([{ __type: 'CALLBACK_REF', id }])[0] as (...args: any[]) => Promise<unknown>
    return { host, postMessage, getCallback }
}

describe('SandboxHost.terminate', () => {
    beforeAll(() => {
        // happy-dom does not provide ImageBitmap, which collectTransferables checks.
        if (typeof ImageBitmap === 'undefined') {
            vi.stubGlobal('ImageBitmap', class {})
        }
    })

    it('rejects callback calls that are still waiting for the iframe', async () => {
        const { host, postMessage, getCallback } = createHost()
        const callback = getCallback('cb_1')

        const pending = callback('content')
        expect(postMessage).toHaveBeenCalledTimes(1)

        host.terminate()

        await expect(pending).rejects.toThrow('Plugin sandbox has been terminated')
    })

    it('makes callback wrappers kept by host code fail fast after termination', async () => {
        const { host, postMessage, getCallback } = createHost()
        const callback = getCallback('cb_1')

        host.terminate()

        await expect(callback('content')).rejects.toThrow('Plugin sandbox has been terminated')
        expect(postMessage).not.toHaveBeenCalled()
    })

    it('aborts signals the guest can no longer abort', () => {
        const { host } = createHost()
        const [arg] = (host as any).deserializeArgs([
            { signal: { __type: 'ABORT_SIGNAL_REF', abortId: 'abort_1', aborted: false } },
        ])
        const signal = arg.signal as AbortSignal
        expect(signal.aborted).toBe(false)

        host.terminate()

        expect(signal.aborted).toBe(true)
    })
})
