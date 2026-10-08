/**
 * Model selection for providers whose concrete model is picked from a model
 * grid (OpenRouter, NanoGPT, Ollama). Each provider has one global selection in
 * `gridModels`, and each aux slot can override it in `gridModelOverrides`.
 */

export const gridModelProviders = ['openrouter', 'nanogpt', 'ollama-hosted', 'ollama-cloud'] as const
export type GridModelProvider = typeof gridModelProviders[number]

export const gridModelSlots = ['submodel', 'memory', 'emotion', 'translate', 'otherAx'] as const
export type GridModelSlot = typeof gridModelSlots[number]

export type GridModelSelection = {
    id: string
    /** Display name from the model grid; absent for manually typed ids */
    name?: string
}

export type GridModelSelections = {
    [provider in GridModelProvider]?: GridModelSelection
}

/** Empty or missing entries mean "use the provider's global selection" */
export type GridModelOverrides = {
    [slot in GridModelSlot]?: GridModelSelections
}

export const defaultOpenRouterModel = 'openai/gpt-3.5-turbo'

type GridModelDBLike = {
    seperateModelsForAxModels?: boolean
    seperateModels?: { [key: string]: string }
    gridModels?: GridModelSelections
    gridModelOverrides?: GridModelOverrides
}

export function isGridModelProvider(id: string): id is GridModelProvider {
    return (gridModelProviders as readonly string[]).includes(id)
}

function setSelection(target: GridModelSelections, provider: GridModelProvider, id: string, name?: string) {
    if (!id) {
        delete target[provider]
        return
    }
    target[provider] = name ? { id, name } : { id }
}

export function getGridModel(db: GridModelDBLike, provider: GridModelProvider): GridModelSelection {
    return db.gridModels?.[provider] ?? { id: '' }
}

/** Setting an id without a name clears the stored name */
export function setGridModel(db: GridModelDBLike, provider: GridModelProvider, id: string, name?: string) {
    db.gridModels ??= {}
    setSelection(db.gridModels, provider, id, name)
}

/** Clears the global selection and every slot override of a provider */
export function clearGridModelEverywhere(db: GridModelDBLike, provider: GridModelProvider) {
    setGridModel(db, provider, '')
    for (const slot of gridModelSlots) {
        if (db.gridModelOverrides?.[slot]) {
            setSelection(db.gridModelOverrides[slot], provider, '')
        }
    }
}

/**
 * Which override slot a request uses. Returns null for the main model and for
 * fallback models, which always use the global selection.
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

export function getGridModelOverride(db: GridModelDBLike, slot: GridModelSlot | null, aiModel: string): GridModelSelection | null {
    if (!slot || !isGridModelProvider(aiModel)) {
        return null
    }
    const override = db.gridModelOverrides?.[slot]?.[aiModel]
    return override?.id ? override : null
}

export function setGridModelOverride(db: GridModelDBLike, slot: GridModelSlot, provider: GridModelProvider, id: string, name?: string) {
    db.gridModelOverrides ??= {}
    db.gridModelOverrides[slot] ??= {}
    setSelection(db.gridModelOverrides[slot], provider, id, name)
}

/** The model id a request should send: the slot override if any, else the global selection */
export function resolveGridModelId(db: GridModelDBLike, aiModel: string, override?: GridModelSelection | null): string {
    if (!isGridModelProvider(aiModel)) {
        return ''
    }
    return override?.id || getGridModel(db, aiModel).id
}

/** Fields used before gridModels existed */
export type LegacyGridModelFields = {
    aiModel?: string
    subModel?: string
    openrouterRequestModel?: string
    nanogptRequestModel?: string
    nanogptRequestModelName?: string
    ollamaModel?: string
    ollamaModelName?: string
    ollamaCloudModel?: string
    ollamaCloudModelName?: string
}

export function migrateLegacyGridModels(legacy: LegacyGridModelFields): GridModelSelections {
    const result: GridModelSelections = {}
    setSelection(result, 'openrouter', legacy.openrouterRequestModel ?? defaultOpenRouterModel)
    setSelection(result, 'nanogpt', legacy.nanogptRequestModel, legacy.nanogptRequestModelName)
    setSelection(result, 'ollama-hosted', legacy.ollamaModel, legacy.ollamaModelName)

    // Ollama Cloud used to share ollamaModel before it got its own field
    const usesOllamaCloud = legacy.aiModel === 'ollama-cloud' || legacy.subModel === 'ollama-cloud'
    if (!legacy.ollamaCloudModel && usesOllamaCloud) {
        setSelection(result, 'ollama-cloud', legacy.ollamaModel, legacy.ollamaModelName)
    }
    else {
        setSelection(result, 'ollama-cloud', legacy.ollamaCloudModel, legacy.ollamaCloudModelName)
    }
    return result
}
