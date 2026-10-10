<script lang="ts">
    import { language } from "src/lang";
    import {
        attributionFingerprint,
        peekLocalAttributionIdentity,
        type AttributionEntry,
        type CardAttribution,
    } from "src/ts/cardAttribution";
    import { DBState } from "src/ts/stores.svelte";

    interface Props {
        attribution?: CardAttribution;
        imported?: boolean;
    }

    let { attribution, imported = false }: Props = $props();

    const me = $derived(peekLocalAttributionIdentity(DBState.db));

    // A character made here has no record until it is exported; the exporter will be credited as original.
    const original = $derived<AttributionEntry | null>(
        attribution ? attribution.original : (imported ? null : me)
    );
    const forks = $derived(attribution?.forks ?? []);
</script>

{#snippet entry(e: AttributionEntry)}
    <span class="text-textcolor">{e.name || language.originalCreatorUnknown}</span>
    <span class="text-textcolor2 font-mono text-xs ml-1">{attributionFingerprint(e.id)}</span>
    {#if e.id === me?.id}
        <span class="text-textcolor2 text-xs ml-1">({language.attributionYou})</span>
    {/if}
{/snippet}

<div class="flex flex-col text-sm mt-2 mb-2">
    <span class="text-textcolor">{language.originalCreator}</span>
    <div class="ml-2" class:opacity-60={attribution?.unverified}>
        {#if original}
            {@render entry(original)}
        {:else}
            <span class="text-textcolor2">{language.originalCreatorUnknown}</span>
        {/if}
    </div>
    {#if attribution?.unverified}
        <span class="ml-2 text-textcolor2 text-xs" title={language.creatorSignatureMismatchDesc}>
            {language.creatorSignatureMismatch}
        </span>
    {/if}

    {#if forks.length > 0}
        <span class="text-textcolor mt-2">{language.forkCreator}</span>
        {#each forks as fork, i (i)}
            <div class="ml-2">{@render entry(fork)}</div>
        {/each}
    {/if}
</div>
