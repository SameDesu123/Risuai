import { getDatabase } from "src/ts/storage/database.svelte";
import { getGridModel } from "src/ts/model/gridModels";

export function getGenerationModelString(name?:string){
    const db = getDatabase()
    const model = name ?? db.aiModel
    switch (model){
        case 'reverse_proxy':
            return 'custom-' + (db.reverseProxyOobaMode ? 'ooba' : db.customProxyRequestModel)
        case 'openrouter':
            return 'openrouter-' + getGridModel(db, 'openrouter').id
        case 'nanogpt': {
            const selected = getGridModel(db, 'nanogpt')
            return 'NanoGPT ' + (selected.name || selected.id) + (db.nanogptUseSubscriptionEndpoint ? ' [SUB]' : '')
        }
        case 'ollama-hosted':
        case 'ollama-cloud': {
            const selected = getGridModel(db, model)
            return `Ollama ${model === 'ollama-cloud' ? 'Cloud' : 'Local'} ${selected.name || selected.id}`
        }
        default:
            return model
    }
}
