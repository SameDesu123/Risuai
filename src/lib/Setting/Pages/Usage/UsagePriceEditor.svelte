<script lang="ts">
    import { untrack } from "svelte";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import type { ModelPrice, PriceMatch } from "src/ts/usage/pricing";

    interface Props {
        /** The price in effect, which the fields start from. */
        match: PriceMatch | undefined
        /** Saves a price of your own, or removes it with undefined. */
        onSave: (price: ModelPrice | undefined) => void
    }

    let { match, onSave }: Props = $props()

    type Field = keyof ModelPrice
    const fields: { key: Field, label: string, optional?: boolean }[] = [
        { key: 'input', label: language.usage.input },
        { key: 'output', label: language.usage.output },
        { key: 'cacheRead', label: language.usage.cacheRead, optional: true },
        { key: 'cacheWrite', label: language.usage.cacheWrite, optional: true },
    ]

    // The editor is opened anew for each model, so it only needs the price it was opened with.
    const start = untrack(() => match?.price)
    let draft = $state<Record<Field, number | null | undefined>>({
        input: start?.input,
        output: start?.output,
        cacheRead: start?.cacheRead,
        cacheWrite: start?.cacheWrite,
    })

    /** An empty number field holds null. */
    const priceOf = (value: number | null | undefined) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

    // Cache prices may stay empty, and then cost the same as input.
    const valid = $derived(priceOf(draft.input) !== undefined && priceOf(draft.output) !== undefined)

    const source = $derived(
        match?.source === 'custom' ? language.usage.priceCustom
        : match ? language.usage.priceFromCatalog(`${match.catalogProvider}/${match.catalogModel}`)
        : language.usage.priceMissing
    )

    function save() {
        onSave({
            input: priceOf(draft.input),
            output: priceOf(draft.output),
            cacheRead: priceOf(draft.cacheRead),
            cacheWrite: priceOf(draft.cacheWrite),
        })
    }
</script>

<div class="flex flex-col gap-3 border-t border-darkborderc bg-textcolor/5 p-3">
    <p class="text-xs text-textcolor2">{source}</p>
    <div class="grid grid-cols-2 gap-2 @lg:grid-cols-4">
        {#each fields as field (field.key)}
            <label class="flex min-w-0 flex-col gap-1 text-xs text-textcolor2">
                {field.label}
                <input
                    type="number"
                    min="0"
                    step="any"
                    inputmode="decimal"
                    class="w-full rounded-md border border-darkborderc bg-transparent px-2 py-1 text-sm text-textcolor shadow-xs transition-colors duration-200 focus:border-borderc focus:ring-2 focus:ring-borderc focus:outline-hidden"
                    placeholder={field.optional ? language.usage.sameAsInput : '0'}
                    bind:value={draft[field.key]}
                />
            </label>
        {/each}
    </div>
    <div class="flex flex-wrap items-center gap-2">
        <span class="mr-auto text-xs text-textcolor2">{language.usage.pricePerMillion}</span>
        {#if match?.source === 'custom'}
            <Button styled="outlined" size="sm" onclick={() => onSave(undefined)}>{language.usage.resetPrice}</Button>
        {/if}
        <Button size="sm" disabled={!valid} onclick={save}>{language.usage.savePrice}</Button>
    </div>
</div>
