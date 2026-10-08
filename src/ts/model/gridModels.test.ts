import { describe, expect, it } from 'vitest'

import {
    clearGridModelEverywhere,
    getGridModel,
    getGridModelOverride,
    isGridModelProvider,
    migrateLegacyGridModels,
    resolveGridModelId,
    resolveGridModelSlot,
    setGridModel,
    setGridModelOverride,
} from './gridModels'

describe('resolveGridModelSlot', () => {
    it('returns null for mode "model"', () => {
        expect(resolveGridModelSlot({}, 'model')).toBeNull()
    })

    it('returns null when staticModel is non-empty (fallback)', () => {
        expect(resolveGridModelSlot({}, 'submodel', 'gpt4o')).toBeNull()
        expect(resolveGridModelSlot({ seperateModelsForAxModels: true, seperateModels: { memory: 'x' } }, 'memory', 'gpt4o')).toBeNull()
    })

    it('returns "submodel" for mode "submodel"', () => {
        expect(resolveGridModelSlot({}, 'submodel')).toBe('submodel')
    })

    it('returns "memory" for mode "memory" only when separate models are enabled and configured', () => {
        expect(resolveGridModelSlot({
            seperateModelsForAxModels: true,
            seperateModels: { memory: 'some-model' },
        }, 'memory')).toBe('memory')
    })

    it('falls back to "submodel" for mode "memory" when separate models are disabled', () => {
        expect(resolveGridModelSlot({
            seperateModelsForAxModels: false,
            seperateModels: { memory: 'some-model' },
        }, 'memory')).toBe('submodel')
    })

    it('falls back to "submodel" for mode "memory" when seperateModels.memory is empty', () => {
        expect(resolveGridModelSlot({
            seperateModelsForAxModels: true,
            seperateModels: { memory: '' },
        }, 'memory')).toBe('submodel')
    })
})

describe('getGridModelOverride', () => {
    it('returns null for a null slot', () => {
        expect(getGridModelOverride({}, null, 'openrouter')).toBeNull()
    })

    it('returns null for a non-grid provider', () => {
        expect(getGridModelOverride({
            gridModelOverrides: { submodel: { openrouter: { id: 'a/b' } } },
        }, 'submodel', 'gpt4o')).toBeNull()
    })

    it('returns null when the stored id is empty or missing', () => {
        expect(getGridModelOverride({
            gridModelOverrides: { submodel: { openrouter: { id: '' } } },
        }, 'submodel', 'openrouter')).toBeNull()
        expect(getGridModelOverride({}, 'submodel', 'openrouter')).toBeNull()
    })

    it('returns the stored object when present', () => {
        const override = { id: 'meta/llama', name: 'Llama' }
        expect(getGridModelOverride({
            gridModelOverrides: { submodel: { openrouter: override } },
        }, 'submodel', 'openrouter')).toEqual(override)
    })
})

describe('setGridModelOverride', () => {
    it('creates nested objects on an empty db object', () => {
        const db: Parameters<typeof setGridModelOverride>[0] = {}
        setGridModelOverride(db, 'translate', 'nanogpt', 'model-1')
        expect(db.gridModelOverrides).toEqual({ translate: { nanogpt: { id: 'model-1' } } })
    })

    it('stores {id} without name when no name is given', () => {
        const db: Parameters<typeof setGridModelOverride>[0] = {}
        setGridModelOverride(db, 'submodel', 'openrouter', 'a/b')
        expect(db.gridModelOverrides?.submodel?.openrouter).toStrictEqual({ id: 'a/b' })
    })

    it('stores {id, name} when a name is given', () => {
        const db: Parameters<typeof setGridModelOverride>[0] = {}
        setGridModelOverride(db, 'submodel', 'openrouter', 'a/b', 'Model B')
        expect(db.gridModelOverrides?.submodel?.openrouter).toStrictEqual({ id: 'a/b', name: 'Model B' })
    })

    it('removes the provider entry when id is empty', () => {
        const db: Parameters<typeof setGridModelOverride>[0] = {}
        setGridModelOverride(db, 'memory', 'ollama-cloud', 'llama3')
        setGridModelOverride(db, 'memory', 'ollama-cloud', '')
        expect(db.gridModelOverrides?.memory).toEqual({})
        expect(getGridModelOverride(db, 'memory', 'ollama-cloud')).toBeNull()
    })
})

describe('isGridModelProvider', () => {
    it.each(['openrouter', 'nanogpt', 'ollama-hosted', 'ollama-cloud'])('returns true for %s', (id) => {
        expect(isGridModelProvider(id)).toBe(true)
    })

    it.each(['gpt4o', 'claude', 'ollama', ''])('returns false for %s', (id) => {
        expect(isGridModelProvider(id)).toBe(false)
    })
})

describe('getGridModel', () => {
    it('returns { id: "" } when gridModels is missing', () => {
        expect(getGridModel({}, 'openrouter')).toEqual({ id: '' })
    })

    it('returns the stored selection when present', () => {
        const selection = { id: 'meta/llama', name: 'Llama' }
        expect(getGridModel({ gridModels: { openrouter: selection } }, 'openrouter')).toEqual(selection)
    })
})

describe('setGridModel', () => {
    it('creates gridModels on an empty object', () => {
        const db: Parameters<typeof setGridModel>[0] = {}
        setGridModel(db, 'nanogpt', 'model-1')
        expect(db.gridModels).toEqual({ nanogpt: { id: 'model-1' } })
    })

    it('stores {id} without name when no name is given', () => {
        const db: Parameters<typeof setGridModel>[0] = {}
        setGridModel(db, 'openrouter', 'a/b')
        expect(db.gridModels?.openrouter).toStrictEqual({ id: 'a/b' })
    })

    it('stores {id, name} when a name is given', () => {
        const db: Parameters<typeof setGridModel>[0] = {}
        setGridModel(db, 'openrouter', 'a/b', 'Model B')
        expect(db.gridModels?.openrouter).toStrictEqual({ id: 'a/b', name: 'Model B' })
    })

    it('drops the old name when a new id is set without a name', () => {
        const db: Parameters<typeof setGridModel>[0] = {}
        setGridModel(db, 'openrouter', 'a/b', 'Model B')
        setGridModel(db, 'openrouter', 'c/d')
        expect(db.gridModels?.openrouter).toStrictEqual({ id: 'c/d' })
    })

    it('deletes the provider entry when id is empty', () => {
        const db: Parameters<typeof setGridModel>[0] = {
            gridModels: { openrouter: { id: 'a/b' }, nanogpt: { id: 'x' } },
        }
        setGridModel(db, 'openrouter', '')
        expect(db.gridModels).toEqual({ nanogpt: { id: 'x' } })
        expect(getGridModel(db, 'openrouter')).toEqual({ id: '' })
    })
})

describe('clearGridModelEverywhere', () => {
    it('removes the provider from gridModels and from every override slot', () => {
        const db: Parameters<typeof clearGridModelEverywhere>[0] = {
            gridModels: { openrouter: { id: 'a/b', name: 'B' }, nanogpt: { id: 'n' } },
            gridModelOverrides: {
                submodel: { openrouter: { id: 'c/d' }, nanogpt: { id: 'n2' } },
                memory: { openrouter: { id: 'e/f' } },
                emotion: { 'ollama-cloud': { id: 'o' } },
                translate: { openrouter: { id: 'g/h', name: 'H' } },
                otherAx: { openrouter: { id: 'i/j' } },
            },
        }
        clearGridModelEverywhere(db, 'openrouter')

        expect(db.gridModels).toEqual({ nanogpt: { id: 'n' } })
        expect(db.gridModelOverrides?.submodel).toEqual({ nanogpt: { id: 'n2' } })
        expect(db.gridModelOverrides?.memory).toEqual({})
        expect(db.gridModelOverrides?.translate).toEqual({})
        expect(db.gridModelOverrides?.otherAx).toEqual({})
        expect(db.gridModelOverrides?.emotion).toEqual({ 'ollama-cloud': { id: 'o' } })
    })

    it('works when gridModelOverrides is missing', () => {
        const db: Parameters<typeof clearGridModelEverywhere>[0] = {
            gridModels: { openrouter: { id: 'a/b' } },
        }
        clearGridModelEverywhere(db, 'openrouter')
        expect(db.gridModels).toEqual({})
        expect(db.gridModelOverrides).toBeUndefined()
    })
})

describe('resolveGridModelId', () => {
    it('returns "" for a non-grid provider', () => {
        expect(resolveGridModelId({ gridModels: { openrouter: { id: 'a/b' } } }, 'gpt4o')).toBe('')
    })

    it('returns the override id when an override with a non-empty id is given', () => {
        expect(resolveGridModelId(
            { gridModels: { openrouter: { id: 'global/model' } } },
            'openrouter',
            { id: 'override/model' },
        )).toBe('override/model')
    })

    it('returns the global id when the override is null or has an empty id', () => {
        const db = { gridModels: { openrouter: { id: 'global/model' } } }
        expect(resolveGridModelId(db, 'openrouter', null)).toBe('global/model')
        expect(resolveGridModelId(db, 'openrouter', { id: '' })).toBe('global/model')
        expect(resolveGridModelId(db, 'openrouter')).toBe('global/model')
    })

    it('returns "" when nothing is set', () => {
        expect(resolveGridModelId({}, 'openrouter')).toBe('')
        expect(resolveGridModelId({}, 'openrouter', null)).toBe('')
    })
})

describe('migrateLegacyGridModels', () => {
    it('returns the default openrouter model for an empty legacy object', () => {
        expect(migrateLegacyGridModels({})).toEqual({ openrouter: { id: 'openai/gpt-3.5-turbo' } })
    })

    it('maps openrouterRequestModel to openrouter', () => {
        expect(migrateLegacyGridModels({ openrouterRequestModel: 'a/b' })).toEqual({
            openrouter: { id: 'a/b' },
        })
    })

    it('maps nanogpt request model and name to nanogpt', () => {
        expect(migrateLegacyGridModels({
            nanogptRequestModel: 'n-1',
            nanogptRequestModelName: 'Nano One',
        })).toEqual({
            openrouter: { id: 'openai/gpt-3.5-turbo' },
            nanogpt: { id: 'n-1', name: 'Nano One' },
        })
    })

    it('maps ollama fields to ollama-hosted and ollama cloud fields to ollama-cloud', () => {
        expect(migrateLegacyGridModels({
            ollamaModel: 'llama3',
            ollamaModelName: 'Llama 3',
            ollamaCloudModel: 'llama3-cloud',
            ollamaCloudModelName: 'Llama 3 Cloud',
        })).toEqual({
            openrouter: { id: 'openai/gpt-3.5-turbo' },
            'ollama-hosted': { id: 'llama3', name: 'Llama 3' },
            'ollama-cloud': { id: 'llama3-cloud', name: 'Llama 3 Cloud' },
        })
    })

    it('produces no entry for a provider whose legacy id is empty', () => {
        const result = migrateLegacyGridModels({
            openrouterRequestModel: 'a/b',
            nanogptRequestModel: '',
            nanogptRequestModelName: 'Ignored',
            ollamaModel: '',
            ollamaModelName: 'Ignored',
            ollamaCloudModel: '',
        })
        expect(result).toEqual({ openrouter: { id: 'a/b' } })
        expect(result).not.toHaveProperty('nanogpt')
        expect(result).not.toHaveProperty('ollama-hosted')
        expect(result).not.toHaveProperty('ollama-cloud')
    })

    it('gives ollama-cloud the ollamaModel values when aiModel is ollama-cloud and ollamaCloudModel is empty', () => {
        expect(migrateLegacyGridModels({
            aiModel: 'ollama-cloud',
            ollamaModel: 'shared',
            ollamaModelName: 'Shared',
            ollamaCloudModel: '',
        })).toEqual({
            openrouter: { id: 'openai/gpt-3.5-turbo' },
            'ollama-hosted': { id: 'shared', name: 'Shared' },
            'ollama-cloud': { id: 'shared', name: 'Shared' },
        })
    })

    it('gives ollama-cloud the ollamaModel values when subModel is ollama-cloud and ollamaCloudModel is empty', () => {
        const result = migrateLegacyGridModels({
            subModel: 'ollama-cloud',
            ollamaModel: 'shared',
        })
        expect(result['ollama-cloud']).toEqual({ id: 'shared' })
    })

    it('prefers ollamaCloudModel over ollamaModel when it is set', () => {
        expect(migrateLegacyGridModels({
            aiModel: 'ollama-cloud',
            ollamaModel: 'shared',
            ollamaModelName: 'Shared',
            ollamaCloudModel: 'cloud-only',
            ollamaCloudModelName: 'Cloud Only',
        })['ollama-cloud']).toEqual({ id: 'cloud-only', name: 'Cloud Only' })
    })
})
