<script lang="ts">
    import { onMount } from "svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import { alertConfirm, alertError, alertNormal } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { DBState } from "src/ts/stores.svelte";
    import {
        buildHeatmap,
        dailyTokens,
        firstUsageDay,
        rangeSpan,
        summarize,
        usageRanges,
        type PriceLookup,
        type UsageRangeId,
        type UsageTotal,
    } from "src/ts/usage/aggregate";
    import { usageCsv } from "src/ts/usage/csv";
    import { localeOf, usageFormat } from "src/ts/usage/format";
    import { findPrice, loadPriceCatalog, type CustomPrices, type ModelPrice, type PriceCatalog, type PriceMatch } from "src/ts/usage/pricing";
    import { usageStore } from "src/ts/usage/store";
    import { modelKey, totalTokens, type UsageDays } from "src/ts/usage/types";
    import UsageHeatmap from "./UsageHeatmap.svelte";
    import UsageModelRow from "./UsageModelRow.svelte";

    let days = $state.raw<UsageDays>({})
    let catalog = $state.raw<PriceCatalog | undefined>()
    let customPrices = $state.raw<CustomPrices>({})
    let status = $state<'loading' | 'ready' | 'failed'>('loading')
    let today = $state(new Date())

    let range = $state<UsageRangeId>('1m')
    /** A day picked on the heatmap. While set, it is shown instead of the range. */
    let selectedDay = $state<string | null>(null)
    /** The provider and model whose price editor is open. */
    let editing = $state<string | null>(null)

    const format = $derived(usageFormat(localeOf(DBState.db.language)))

    // Finding a price tries many spellings of the model name, so each model is looked up once.
    const priceOf = $derived.by(() => {
        // Read here, not in the function below, so the cache starts over when either changes.
        const prices = { catalog, customPrices }
        const matches = new Map<string, PriceMatch | undefined>()
        return (provider: string, model: string) => {
            const key = modelKey(provider, model)
            if(!matches.has(key)){
                matches.set(key, findPrice(prices.catalog, prices.customPrices, provider, model))
            }
            return matches.get(key)
        }
    })
    const priceLookup: PriceLookup = (provider, model) => priceOf(provider, model)?.price

    const firstDay = $derived(firstUsageDay(days))
    const span = $derived(selectedDay ? { from: selectedDay, to: selectedDay } : rangeSpan(range, today))
    /** The first day of the span, or of the history when the span has no start. */
    const spanStart = $derived(span.from ?? firstDay ?? span.to)
    const summary = $derived(summarize(days, span, priceLookup))
    const heatmap = $derived(buildHeatmap(dailyTokens(days), today, firstDay))

    const totals = $derived(summary.total.counters)
    const allTokens = $derived(totalTokens(totals))
    const promptTokens = $derived(totals.input + totals.cacheRead + totals.cacheWrite)
    const periodLabel = $derived(selectedDay ? format.day(selectedDay) : format.days(spanStart, span.to))
    const rangeOptions = $derived(usageRanges.map(({ id }) => ({ value: id, label: language.usage.ranges[id] })))

    /** A cost of $0 would be wrong when some of the tokens have no price. */
    const costText = (total: UsageTotal) => total.cost === 0 && total.unpricedTokens > 0 ? '–' : format.cost(total.cost)
    const shareOf = (total: UsageTotal) => allTokens > 0 ? totalTokens(total.counters) / allTokens : 0

    function dayDetail(day: string): string {
        const total = summarize(days, { from: day, to: day }, priceLookup).total
        return `${language.usage.requestCount(format.count(total.counters.requests))} · ${costText(total)}`
    }

    async function loadHistory() {
        days = await usageStore.loadHistory()
        today = new Date()
    }

    onMount(() => {
        Promise.all([
            loadHistory(),
            usageStore.loadCustomPrices().then((prices) => { customPrices = prices }),
            // Costs can still be shown for prices entered by hand.
            loadPriceCatalog().then((loaded) => { catalog = loaded }, (error) => console.error('[usage] Could not load prices', error)),
        ]).then(() => {
            status = 'ready'
        }, (error) => {
            console.error('[usage] Could not load usage', error)
            status = 'failed'
        })

        // Requests can finish while the page is open, like a memory summary running in the background.
        let reload: ReturnType<typeof setTimeout> | undefined
        const stop = usageStore.onRecord(() => {
            clearTimeout(reload)
            reload = setTimeout(() => loadHistory().catch((error) => console.error(error)), 1000)
        })
        return () => {
            stop()
            clearTimeout(reload)
        }
    })

    async function savePrice(key: string, price: ModelPrice | undefined) {
        const next = { ...customPrices }
        if(price){
            next[key] = price
        }
        else{
            delete next[key]
        }
        customPrices = next
        editing = null
        try {
            await usageStore.saveCustomPrices(next)
        } catch (error) {
            alertError(error)
        }
    }

    async function exportCsv() {
        try {
            // The byte order mark makes Excel read the file as UTF-8.
            await downloadFile(`risuai-usage-${spanStart}-${span.to}.csv`, '\uFEFF' + usageCsv(days, span, priceLookup))
            alertNormal(language.successExport)
        } catch (error) {
            alertError(error)
        }
    }

    async function clearHistory() {
        if(!await alertConfirm(language.usage.clearConfirm)){
            return
        }
        try {
            await usageStore.clearHistory()
            days = {}
            selectedDay = null
        } catch (error) {
            alertError(error)
        }
    }
</script>

{#snippet stat(label: string, value: string, note: string)}
    <div class="flex min-w-0 flex-col gap-1 rounded-md border border-darkborderc bg-darkbg p-3">
        <span class="text-xs text-textcolor2">{label}</span>
        <span class="truncate text-xl font-semibold tabular-nums">{value}</span>
        <span class="min-h-4 truncate text-xs text-textcolor2">{note}</span>
    </div>
{/snippet}

<h2 class="mb-2 text-2xl font-bold mt-2">{language.usage.title}</h2>
<p class="mb-4 text-sm text-textcolor2">{language.usage.description}</p>

{#if status === 'loading'}
    <div class="h-40 animate-pulse rounded-md bg-textcolor/5"></div>
{:else if status === 'failed'}
    <p class="text-draculared">{language.usage.loadFailed}</p>
{:else}
    <div class="@container flex flex-col gap-4">
        <div class="rounded-md border border-darkborderc bg-darkbg p-3">
            <UsageHeatmap
                {heatmap}
                {format}
                {selectedDay}
                detail={dayDetail}
                onSelect={(day) => { selectedDay = selectedDay === day ? null : day }}
            />
        </div>

        {#if !firstDay}
            <p class="text-sm text-textcolor2">{language.usage.empty}</p>
        {:else}
            <div class="flex flex-wrap items-center gap-2">
                <div class="max-w-full overflow-x-auto">
                    <SegmentedControl
                        size="sm"
                        className="mb-0!"
                        options={rangeOptions}
                        bind:value={
                            () => selectedDay ? '' : range,
                            (value) => {
                                range = value as UsageRangeId
                                selectedDay = null
                            }
                        }
                    />
                </div>
                {#if selectedDay}
                    <button
                        type="button"
                        class="ml-auto flex items-center gap-1 rounded-full border border-borderc px-3 py-1 text-sm hover:bg-textcolor/5"
                        title={language.usage.backToPeriod}
                        onclick={() => { selectedDay = null }}
                    >
                        {periodLabel}
                        <span aria-hidden="true">✕</span>
                    </button>
                {:else}
                    <span class="ml-auto text-sm text-textcolor2">{periodLabel}</span>
                {/if}
            </div>

            <div class="grid grid-cols-2 gap-2 @lg:grid-cols-4">
                {@render stat(
                    language.usage.cost,
                    costText(summary.total),
                    summary.total.unpricedTokens > 0 ? language.usage.unpricedTokens(format.tokens(summary.total.unpricedTokens)) : '',
                )}
                {@render stat(
                    language.usage.tokens,
                    format.tokens(allTokens),
                    `${language.usage.input} ${format.tokens(promptTokens)} · ${language.usage.output} ${format.tokens(totals.output)}`,
                )}
                {@render stat(
                    language.usage.requests,
                    format.count(totals.requests),
                    totals.estimated > 0 ? language.usage.estimatedCount(format.count(totals.estimated)) : '',
                )}
                {@render stat(
                    language.usage.cacheHitRate,
                    promptTokens > 0 ? format.percent(totals.cacheRead / promptTokens) : '–',
                    `${language.usage.cacheRead} ${format.tokens(totals.cacheRead)}`,
                )}
            </div>

            {#if summary.models.length === 0}
                <p class="text-sm text-textcolor2">{language.usage.emptyPeriod}</p>
            {:else}
                <section class="flex flex-col gap-2">
                    <h3 class="text-lg font-semibold">{language.usage.byModel}</h3>
                    {#each summary.models as usage (modelKey(usage.provider, usage.model))}
                        {@const key = modelKey(usage.provider, usage.model)}
                        <UsageModelRow
                            {usage}
                            {format}
                            share={shareOf(usage)}
                            match={priceOf(usage.provider, usage.model)}
                            open={editing === key}
                            onToggle={() => { editing = editing === key ? null : key }}
                            onSavePrice={(price) => savePrice(key, price)}
                        />
                    {/each}
                </section>

                <section class="flex flex-col gap-2">
                    <h3 class="text-lg font-semibold">{language.usage.byPurpose}</h3>
                    <div class="flex flex-col gap-3 rounded-md border border-darkborderc p-3">
                        {#each summary.purposes as usage (usage.purpose)}
                            <div class="flex flex-col gap-1">
                                <div class="flex items-center gap-3 text-sm">
                                    <span>{language.usage.purposes[usage.purpose] ?? usage.purpose}</span>
                                    <span class="ml-auto text-textcolor2 tabular-nums">{format.tokens(totalTokens(usage.counters))}</span>
                                    <span class="w-20 text-right tabular-nums">{costText(usage)}</span>
                                </div>
                                <div class="h-1.5 w-full overflow-hidden rounded-full bg-textcolor/10">
                                    <div class="h-full rounded-full bg-borderc" style:width="{shareOf(usage) * 100}%"></div>
                                </div>
                            </div>
                        {/each}
                    </div>
                </section>
            {/if}

            <div class="flex flex-wrap gap-2">
                <Button styled="outlined" size="sm" onclick={exportCsv}>{language.usage.exportCsv}</Button>
                <Button styled="danger" size="sm" onclick={clearHistory}>{language.usage.clearHistory}</Button>
            </div>
        {/if}

        <div class="flex flex-col gap-1 text-xs text-textcolor2">
            <p>{language.usage.estimatedNote}</p>
            {#if catalog}
                <p>{language.usage.priceNote(catalog.updated)}</p>
            {/if}
        </div>
    </div>
{/if}
