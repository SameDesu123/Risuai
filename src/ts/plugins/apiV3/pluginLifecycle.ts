export type UnloadCallback = () => unknown

/**
 * Liveness flag shared by everything a single plugin instance registers.
 * It flips to false as soon as the instance starts unloading.
 */
export type PluginLifecycle = {
    alive: boolean
}

const runUnloadCallback = async (pluginName: string, callback: UnloadCallback) => {
    try {
        await callback()
    } catch (error) {
        console.error(`Error in unload callback of plugin ${pluginName}:`, error)
    }
}

export class PluginUnloadRegistry {
    #callbacks = new Map<string, UnloadCallback[]>()

    /**
     * Registers a cleanup for the plugin. If the instance already started
     * unloading (e.g. the registration finished after a permission prompt),
     * the cleanup runs right away so the registration does not outlive it.
     */
    add(pluginName: string, lifecycle: PluginLifecycle, callback: UnloadCallback) {
        if (!lifecycle.alive) {
            void runUnloadCallback(pluginName, callback)
            return
        }
        const callbacks = this.#callbacks.get(pluginName)
        if (callbacks) {
            callbacks.push(callback)
        } else {
            this.#callbacks.set(pluginName, [callback])
        }
    }

    /**
     * Marks the instance as unloading and runs every registered cleanup.
     * A throwing or rejecting cleanup does not stop the others, and the wait
     * for async cleanups is capped at timeoutMs.
     */
    async run(pluginName: string, lifecycle: PluginLifecycle, timeoutMs: number) {
        lifecycle.alive = false
        const callbacks = this.#callbacks.get(pluginName) ?? []
        this.#callbacks.delete(pluginName)

        const pending = callbacks.map((callback) => runUnloadCallback(pluginName, callback))
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs)
        })
        try {
            await Promise.race([Promise.all(pending), timeout])
        } finally {
            clearTimeout(timer)
        }
    }
}

/**
 * Wraps an async task so that at most one run is in flight. Calls made while a
 * run is in flight share a single follow-up run, which starts after the current
 * one settles, so every caller resolves only after a run that began after its call.
 */
export const createCoalescedRunner = (task: () => Promise<void>) => {
    let inFlight: Promise<void> | null = null
    let queued: Promise<void> | null = null

    const start = () => {
        const run = task().finally(() => {
            if (inFlight === run) {
                inFlight = null
            }
        })
        inFlight = run
        return run
    }

    return (): Promise<void> => {
        if (queued) {
            return queued
        }
        if (!inFlight) {
            return start()
        }
        queued = inFlight
            .catch(() => {})
            .then(() => {
                queued = null
                return start()
            })
        return queued
    }
}
