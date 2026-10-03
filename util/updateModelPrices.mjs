// Updates src/ts/usage/modelPrices.json from the models.dev catalog (https://github.com/sst/models.dev).
//
//   node util/updateModelPrices.mjs              downloads https://models.dev/api.json
//   node util/updateModelPrices.mjs api.json     uses a file that was downloaded before
//
// Only text models of the providers below are kept, and only their prices,
// so the file stays small enough to ship with the app.

import { readFile, writeFile } from 'node:fs/promises'

const output = new URL('../src/ts/usage/modelPrices.json', import.meta.url)

// models.dev provider ids. Pick providers people use from RisuAI,
// either directly or through a custom OpenAI-compatible endpoint.
const providers = [
    'openai', 'anthropic', 'google', 'google-vertex', 'google-vertex-anthropic', 'amazon-bedrock',
    'openrouter', 'nano-gpt', 'deepseek', 'mistral', 'cohere', 'xai', 'deepinfra', 'ollama-cloud',
    'groq', 'togetherai', 'fireworks-ai', 'cerebras', 'perplexity', 'moonshotai', 'moonshotai-cn',
    'zai', 'zhipuai', 'alibaba', 'alibaba-cn', 'minimax', 'minimax-cn', 'novita-ai', 'chutes',
    'nvidia', 'huggingface', 'venice', 'nebius', 'siliconflow', 'siliconflow-cn', 'stepfun', 'xiaomi',
]

// Providers that models.dev reaches through their own SDK have no `api` URL there.
const extraHosts = {
    'api.openai.com': 'openai',
    'api.anthropic.com': 'anthropic',
    'generativelanguage.googleapis.com': 'google',
    'api.mistral.ai': 'mistral',
    'api.cohere.com': 'cohere',
    'api.cohere.ai': 'cohere',
    'api.x.ai': 'xai',
    'api.deepinfra.com': 'deepinfra',
    'api.groq.com': 'groq',
    'api.together.xyz': 'togetherai',
    'api.cerebras.ai': 'cerebras',
    'api.perplexity.ai': 'perplexity',
    'api.venice.ai': 'venice',
}

// Bedrock lists every model once per region prefix. One copy is enough.
const bedrockRegion = /^(us|eu|apac|global|jp|au|in|ca|us-gov)\./

function priceRow(cost) {
    const row = [cost.input, cost.output, cost.cache_read ?? null, cost.cache_write ?? null]
    while(row.at(-1) === null){
        row.pop()
    }
    return row
}

function hostOf(url) {
    try {
        return new URL(url).hostname
    } catch {
        return undefined
    }
}

const source = process.argv[2]
const catalog = source
    ? JSON.parse(await readFile(source, 'utf-8'))
    : await (await fetch('https://models.dev/api.json')).json()

const result = {
    source: 'https://models.dev',
    updated: new Date().toISOString().slice(0, 10),
    hosts: {},
    providers: {},
}

for(const id of providers){
    const provider = catalog[id]
    if(!provider){
        console.warn(`models.dev has no provider "${id}"`)
        continue
    }

    const host = provider.api ? hostOf(provider.api) : undefined
    if(host){
        result.hosts[host] = id
    }

    const prices = {}
    for(const [modelId, model] of Object.entries(provider.models)){
        const cost = model.cost
        if(typeof cost?.input !== 'number' || typeof cost?.output !== 'number'){
            continue
        }
        if(model.modalities && !model.modalities.output?.includes('text')){
            continue
        }
        const key = id === 'amazon-bedrock' ? modelId.replace(bedrockRegion, '') : modelId
        prices[key] ??= priceRow(cost)
    }
    result.providers[id] = Object.fromEntries(Object.entries(prices).sort(([a], [b]) => a.localeCompare(b)))
}

for(const [host, id] of Object.entries(extraHosts)){
    result.hosts[host] ??= id
}

await writeFile(output, JSON.stringify(result) + '\n')
const count = Object.values(result.providers).reduce((sum, models) => sum + Object.keys(models).length, 0)
console.log(`Wrote ${count} model prices from ${Object.keys(result.providers).length} providers`)
