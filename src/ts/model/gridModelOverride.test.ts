import { describe, expect, it } from 'vitest'

import {
    getGridModelOverride,
    isGridModelProvider,
    resolveGridModelSlot,
    setGridModelOverride,
} from './gridModelOverride'

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
