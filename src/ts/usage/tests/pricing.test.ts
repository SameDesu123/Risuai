import { describe, expect, it } from 'vitest'

import { costOf, findCatalogPrice, findPrice, loadPriceCatalog, readCustomPrices, type PriceCatalog } from '../pricing'
import { emptyCounters, modelKey } from '../types'

const catalog: PriceCatalog = {
    source: 'test',
    updated: '2026-10-03',
    hosts: { 'api.deepseek.com': 'deepseek' },
    providers: {
        anthropic: { 'claude-sonnet-4-5': [3, 15, 0.3, 3.75] },
        'amazon-bedrock': { 'anthropic.claude-sonnet-4-5-20250929-v1:0': [3.3, 16.5, 0.33, 4.125] },
        openrouter: { 'anthropic/claude-sonnet-4.5': [3, 15, 0.3, 3.75], 'deepseek/deepseek-v4:free': [0, 0] },
        deepseek: { 'deepseek-v4-flash': [0.3, 1.2, 0.03] },
        google: { 'gemini-2.5-pro': [1.25, 10, null, 0.5] },
    },
}

describe('costOf', () => {
    it('prices each kind of token on its own', () => {
        const counters = { ...emptyCounters(), input: 1_000_000, cacheRead: 2_000_000, cacheWrite: 1_000_000, output: 100_000 }
        expect(costOf(counters, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })).toBeCloseTo(3 + 0.6 + 3.75 + 1.5)
    })

    it('charges the input price for cache tokens without their own price', () => {
        const counters = { ...emptyCounters(), cacheRead: 1_000_000 }
        expect(costOf(counters, { input: 2, output: 8 })).toBe(2)
    })
})

describe('findCatalogPrice', () => {
    it('finds models of a built-in provider', () => {
        expect(findCatalogPrice(catalog, 'anthropic', 'claude-sonnet-4-5')).toMatchObject({
            price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            catalogProvider: 'anthropic',
        })
    })

    it('uses the price of the route before the maker', () => {
        expect(findCatalogPrice(catalog, 'aws', 'anthropic.claude-sonnet-4-5-20250929-v1:0').price.input).toBe(3.3)
        expect(findCatalogPrice(catalog, 'aws', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0').price.input).toBe(3.3)
    })

    it('recognizes custom endpoints by host', () => {
        expect(findCatalogPrice(catalog, 'api.deepseek.com', 'deepseek-v4-flash').catalogProvider).toBe('deepseek')
    })

    it('falls back to the maker price for dated or vendor-prefixed names', () => {
        expect(findCatalogPrice(catalog, 'my-proxy.example', 'claude-sonnet-4-5-20250929')).toMatchObject({
            catalogProvider: 'anthropic',
            catalogModel: 'claude-sonnet-4-5',
        })
        expect(findCatalogPrice(catalog, 'my-proxy.example', 'anthropic/claude-sonnet-4.5').catalogProvider).toBe('openrouter')
        expect(findCatalogPrice(catalog, 'google', 'models/gemini-2.5-pro').price).toEqual({
            input: 1.25,
            output: 10,
            cacheRead: undefined,
            cacheWrite: 0.5,
        })
    })

    it('keeps free variants free', () => {
        expect(findCatalogPrice(catalog, 'openrouter', 'deepseek/deepseek-v4:free').price.input).toBe(0)
    })

    it('returns nothing for unknown models', () => {
        expect(findCatalogPrice(catalog, 'kobold', 'my-local-model')).toBeUndefined()
    })
})

describe('findPrice', () => {
    it('prefers the price the user entered', () => {
        const custom = { [modelKey('anthropic', 'claude-sonnet-4-5')]: { input: 1, output: 2 } }
        expect(findPrice(catalog, custom, 'anthropic', 'claude-sonnet-4-5')).toEqual({ price: { input: 1, output: 2 }, source: 'custom' })
        expect(findPrice(catalog, custom, 'openrouter', 'anthropic/claude-sonnet-4.5').source).toBe('catalog')
    })
})

describe('readCustomPrices', () => {
    it('drops broken entries', () => {
        expect(readCustomPrices({ a: { input: 1, output: 2, cacheRead: -1 }, b: { input: 'x', output: 1 }, c: null })).toEqual({
            a: { input: 1, output: 2, cacheRead: undefined, cacheWrite: undefined },
        })
        expect(readCustomPrices('nope')).toEqual({})
    })
})

describe('bundled snapshot', () => {
    it('loads and has prices of the main providers', async () => {
        const bundled = await loadPriceCatalog()
        expect(Object.keys(bundled.providers)).toEqual(expect.arrayContaining(['openai', 'anthropic', 'google', 'openrouter']))
        expect(bundled.hosts['openrouter.ai']).toBe('openrouter')
    })
})
