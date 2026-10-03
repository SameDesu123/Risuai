<script lang="ts">
    import { language } from "src/lang";
    import type { ModelUsage } from "src/ts/usage/aggregate";
    import { providerName, type UsageFormat } from "src/ts/usage/format";
    import type { ModelPrice, PriceMatch } from "src/ts/usage/pricing";
    import UsagePriceEditor from "./UsagePriceEditor.svelte";

    interface Props {
        usage: ModelUsage
        /** This model's part of all tokens in the period, from 0 to 1. */
        share: number
        match: PriceMatch | undefined
        format: UsageFormat
        /** Whether the price editor is open. */
        open: boolean
        onToggle: () => void
        onSavePrice: (price: ModelPrice | undefined) => void
    }

    let { usage, share, match, format, open, onToggle, onSavePrice }: Props = $props()

    const counters = $derived(usage.counters)
    // Input is the whole prompt, as in the totals above. The cached part is shown inside it.
    const prompt = $derived(counters.input + counters.cacheRead + counters.cacheWrite)
    const cached = $derived(
        [
            counters.cacheRead > 0 ? `${language.usage.cacheRead} ${format.tokens(counters.cacheRead)}` : '',
            counters.cacheWrite > 0 ? `${language.usage.cacheWrite} ${format.tokens(counters.cacheWrite)}` : '',
        ].filter(Boolean).join(', ')
    )
</script>

<div class="overflow-hidden rounded-md border border-darkborderc">
    <button
        type="button"
        class="flex w-full flex-col gap-2 p-3 text-left transition-colors hover:bg-textcolor/5"
        aria-expanded={open}
        onclick={onToggle}
    >
        <div class="flex w-full min-w-0 items-center gap-2">
            <span class="truncate font-medium" title={usage.model}>{usage.model}</span>
            <span class="shrink-0 rounded-sm bg-textcolor/10 px-1.5 py-0.5 text-xs text-textcolor2">
                {providerName(usage.provider, language.usage.providers)}
            </span>
            <span class="ml-auto shrink-0 font-medium tabular-nums" class:text-textcolor2={!match}>
                {match ? format.cost(usage.cost) : language.usage.noPrice}
            </span>
        </div>
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-textcolor/10">
            <div class="h-full rounded-full bg-borderc" style:width="{share * 100}%"></div>
        </div>
        <div class="flex w-full flex-wrap gap-x-3 gap-y-1 text-xs text-textcolor2 tabular-nums">
            <span>{language.usage.requestCount(format.count(counters.requests))}</span>
            <span>{language.usage.input} {format.tokens(prompt)}{cached ? ` (${cached})` : ''}</span>
            <span>{language.usage.output} {format.tokens(counters.output)}</span>
            {#if counters.estimated > 0}
                <span>{language.usage.estimatedCount(format.count(counters.estimated))}</span>
            {/if}
            <span class="ml-auto">{format.percent(share)}</span>
        </div>
    </button>
    {#if open}
        <UsagePriceEditor {match} onSave={onSavePrice} />
    {/if}
</div>
