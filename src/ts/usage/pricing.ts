import { modelKey, type UsageCounters } from './types'

/** Dollars per million tokens. */
export interface ModelPrice {
    input: number
    output: number
    /** Uses the input price when unknown. */
    cacheRead?: number
    /** Uses the input price when unknown. */
    cacheWrite?: number
}

/** Prices the user entered, by {@link modelKey}. */
export type CustomPrices = Record<string, ModelPrice>

export interface PriceMatch {
    price: ModelPrice
    /** The user's own price, or one from the models.dev snapshot. */
    source: 'custom' | 'catalog'
    /** For catalog prices: the models.dev provider and model the price was taken from. */
    catalogProvider?: string
    catalogModel?: string
}

/** The models.dev snapshot in modelPrices.json. Made by util/updateModelPrices.mjs. */
export interface PriceCatalog {
    source: string
    /** When the snapshot was taken (YYYY-MM-DD). */
    updated: string
    /** API host → models.dev provider id, to recognize custom endpoints. */
    hosts: Record<string, string>
    /** models.dev provider id → model id → [input, output, cacheRead?, cacheWrite?] in dollars per million tokens. */
    providers: Record<string, Record<string, (number | null)[]>>
}

let catalog: Promise<PriceCatalog> | undefined

/** The snapshot is loaded on first use, so it stays out of the main bundle. */
export function loadPriceCatalog(): Promise<PriceCatalog> {
    catalog ??= import('./modelPrices.json').then((module) => module.default as PriceCatalog)
    return catalog
}

export function costOf(counters: UsageCounters, price: ModelPrice): number {
    return (
        counters.input * price.input +
        counters.cacheRead * (price.cacheRead ?? price.input) +
        counters.cacheWrite * (price.cacheWrite ?? price.input) +
        counters.output * price.output
    ) / 1_000_000
}

/** RisuAI's own providers (see `usageSource`) and the models.dev providers selling the same models. */
const catalogProvidersOf: Record<string, string[]> = {
    openai: ['openai'],
    anthropic: ['anthropic'],
    google: ['google'],
    vertex: ['google-vertex', 'google-vertex-anthropic'],
    aws: ['amazon-bedrock'],
    mistral: ['mistral'],
    cohere: ['cohere'],
    deepseek: ['deepseek'],
    deepinfra: ['deepinfra'],
    openrouter: ['openrouter'],
    nanogpt: ['nano-gpt'],
    'ollama-cloud': ['ollama-cloud'],
}

/**
 * When the route has no price for a model, the price of the company that made it is a fair guess.
 * Proxies and resellers mostly pass those prices on.
 */
const makerProviders = [
    'openai', 'anthropic', 'google', 'deepseek', 'mistral', 'xai', 'moonshotai',
    'zai', 'alibaba', 'minimax', 'cohere', 'xiaomi', 'stepfun',
]

const bedrockRegion = /^(us|eu|apac|global|jp|au|in|ca|us-gov)\./
const dateSuffix = /(-\d{8}|-\d{4}-\d{2}-\d{2}|@\d{8})$/

/** Spellings to try for a model name, from exact to loose. */
function nameVariants(model: string): string[] {
    const exact = model.trim().replace(/^models\//, '')
    const bare = exact.replace(bedrockRegion, '').split('/').at(-1)
    const undated = bare.replace(dateSuffix, '')
    const names = [exact, bare, undated, bare.replaceAll('.', '-'), undated.replaceAll('.', '-')]
    return [...new Set([...names, ...names.map((name) => name.toLowerCase())])]
}

function readRow(row: (number | null)[]): ModelPrice {
    const [input, output, cacheRead, cacheWrite] = row
    return {
        input,
        output,
        cacheRead: cacheRead ?? undefined,
        cacheWrite: cacheWrite ?? undefined,
    }
}

/** Looks a key up without reaching inherited properties, so a model named "constructor" is not a hit. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
    return Object.hasOwn(record, key) ? record[key] : undefined
}

export function findCatalogPrice(catalog: PriceCatalog, provider: string, model: string): PriceMatch | undefined {
    const host = own(catalog.hosts, provider)
    const route = own(catalogProvidersOf, provider) ?? (host ? [host] : [])
    // "vendor/model" names, as OpenRouter writes them, are common on proxies too.
    const vendor = model.includes('/') ? model.split('/')[0].toLowerCase() : undefined
    const candidates = [...route, ...(vendor ? ['openrouter', vendor] : []), ...makerProviders]

    const names = nameVariants(model)
    for(const catalogProvider of new Set(candidates)){
        const prices = own(catalog.providers, catalogProvider)
        if(!prices){
            continue
        }
        const catalogModel = names.find((name) => own(prices, name))
        if(catalogModel){
            return { price: readRow(prices[catalogModel]), source: 'catalog', catalogProvider, catalogModel }
        }
    }
    return undefined
}

export function findPrice(catalog: PriceCatalog | undefined, custom: CustomPrices, provider: string, model: string): PriceMatch | undefined {
    const customPrice = own(custom, modelKey(provider, model))
    if(customPrice){
        return { price: customPrice, source: 'custom' }
    }
    return catalog ? findCatalogPrice(catalog, provider, model) : undefined
}

/** Keeps only valid prices, so a broken stored document cannot break the page. */
export function readCustomPrices(value: unknown): CustomPrices {
    const result: CustomPrices = {}
    if(!value || typeof value !== 'object'){
        return result
    }
    for(const [key, price] of Object.entries(value)){
        const valid = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
        if(price && valid(price.input) && valid(price.output)){
            result[key] = {
                input: price.input,
                output: price.output,
                cacheRead: valid(price.cacheRead) ? price.cacheRead : undefined,
                cacheWrite: valid(price.cacheWrite) ? price.cacheWrite : undefined,
            }
        }
    }
    return result
}
