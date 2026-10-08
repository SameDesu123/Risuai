/**
 * Per-slot model selection for providers whose concrete model is picked from a
 * model grid (OpenRouter, NanoGPT, Ollama). Without this, every slot that uses
 * the same provider shares one global model setting (e.g. openrouterRequestModel).
 */

export const gridModelProviders = ['openrouter', 'nanogpt', 'ollama-hosted', 'ollama-cloud'] as const
export type GridModelProvider = typeof gridModelProviders[number]

export const gridModelSlots = ['submodel', 'memory', 'emotion', 'translate', 'otherAx'] as const
export type GridModelSlot = typeof gridModelSlots[number]

export type GridModelOverride = {
    id: string
    name?: string
}

/** Empty or missing entries mean "use the provider's global model setting" */
export type GridModelOverrides = {
    [slot in GridModelSlot]?: {
        [provider in GridModelProvider]?: GridModelOverride
    }
}

type GridModelDBLike = {
    seperateModelsForAxModels?: boolean
    seperateModels?: { [key: string]: string }
    gridModelOverrides?: GridModelOverrides
}

export function isGridModelProvider(id: string): id is GridModelProvider {
    return (gridModelProviders as readonly string[]).includes(id)
}

/**
 * Which override slot a request uses. Returns null for the main model and for
 * fallback models, which always use the global provider setting.
 */
export function resolveGridModelSlot(db: GridModelDBLike, mode: string, staticModel?: string): GridModelSlot | null {
    if (staticModel || mode === 'model') {
        return null
    }
    if (mode !== 'submodel' && db.seperateModelsForAxModels && db.seperateModels?.[mode]) {
        return mode as GridModelSlot
    }
    return 'submodel'
}

export function getGridModelOverride(db: GridModelDBLike, slot: GridModelSlot | null, aiModel: string): GridModelOverride | null {
    if (!slot || !isGridModelProvider(aiModel)) {
        return null
    }
    const override = db.gridModelOverrides?.[slot]?.[aiModel]
    return override?.id ? override : null
}

export function setGridModelOverride(db: GridModelDBLike, slot: GridModelSlot, provider: GridModelProvider, id: string, name?: string) {
    db.gridModelOverrides ??= {}
    db.gridModelOverrides[slot] ??= {}
    if (!id) {
        delete db.gridModelOverrides[slot][provider]
        return
    }
    db.gridModelOverrides[slot][provider] = name ? { id, name } : { id }
}
