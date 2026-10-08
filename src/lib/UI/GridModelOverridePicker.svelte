<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte'
    import { language } from 'src/lang'
    import TextInput from './GUI/TextInput.svelte'
    import ModelGrid from './ModelGrid.svelte'
    import { getOpenRouterModels, toModelGridItem as orToGridItem } from 'src/ts/model/openrouter'
    import { getNanoGPTModels, getNanoGPTSubscriptionModels, toModelGridItem as ngToGridItem } from 'src/ts/model/nanogpt'
    import { getOllamaModels } from 'src/ts/model/ollama'
    import {
        isGridModelProvider,
        setGridModelOverride,
        type GridModelSlot,
    } from 'src/ts/model/gridModelOverride'
    import type { ModelGridPinnedItem } from 'src/ts/model/modelGrid'

    interface Props {
        modelSlot: GridModelSlot
        /** The model id selected for this slot, e.g. 'openrouter' */
        provider: string
    }

    let { modelSlot, provider }: Props = $props()

    let useGlobalItem: ModelGridPinnedItem = $derived({ id: '', displayName: language.gridModelUseGlobal, providerName: 'Risu' })
    let openrouterPinnedItems: ModelGridPinnedItem[] = $derived([
        useGlobalItem,
        { id: 'risu/free',       displayName: 'Free Auto',       providerName: 'Risu'       },
        { id: 'openrouter/auto', displayName: 'OpenRouter Auto', providerName: 'OpenRouter' },
    ])

    let override = $derived(isGridModelProvider(provider) ? DBState.db.gridModelOverrides?.[modelSlot]?.[provider] : undefined)

    function setValue(id: string, name?: string) {
        if (!isGridModelProvider(provider)) return
        setGridModelOverride(DBState.db, modelSlot, provider, id, name)
    }

    const getId = () => override?.id ?? ''
    const setId = (id: string) => setValue(id)
</script>

{#if isGridModelProvider(provider)}
    <div class="flex flex-col">
        <span class="text-textcolor2 text-sm mt-2">{language.gridModelSlotModel}</span>
        {#if provider === 'openrouter'}
            {#await getOpenRouterModels()}
                <ModelGrid bind:value={getId, setId} pinnedItems={openrouterPinnedItems} loading={true} />
            {:then m}
                <ModelGrid bind:value={getId, setId} items={(m ?? []).map(orToGridItem)} pinnedItems={openrouterPinnedItems} />
            {/await}
        {:else if provider === 'nanogpt'}
            {#await DBState.db.nanogptUseSubscriptionEndpoint ? getNanoGPTSubscriptionModels(DBState.db.nanogptKey) : getNanoGPTModels()}
                <ModelGrid bind:value={getId, setId} pinnedItems={[useGlobalItem]} loading={true} />
            {:then m}
                <ModelGrid
                    bind:value={getId, setId}
                    items={(m ?? []).map(ngToGridItem)}
                    pinnedItems={[useGlobalItem]}
                    showSubBadge={DBState.db.nanogptUseSubscriptionEndpoint}
                    onselect={(id, name) => setValue(id, name)}
                />
            {/await}
        {:else if provider === 'ollama-cloud' && DBState.db.ollamaInputMode === 'list'}
            {#await getOllamaModels(DBState.db.ollamaURL, 'cloud', DBState.db.ollamaApiKey)}
                <ModelGrid bind:value={getId, setId} pinnedItems={[useGlobalItem]} loading={true} />
            {:then cloudModels}
                <ModelGrid
                    bind:value={getId, setId}
                    items={cloudModels ?? []}
                    pinnedItems={[useGlobalItem]}
                    onselect={(id, name) => setValue(id, name)}
                />
            {/await}
        {:else}
            <TextInput marginBottom={false} size={"sm"} bind:value={getId, setId} placeholder={language.gridModelUseGlobalDesc} />
        {/if}
    </div>
{/if}
