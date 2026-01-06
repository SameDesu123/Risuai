<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import Check from 'src/lib/UI/GUI/CheckInput.svelte';
    import type { Database } from 'src/ts/storage/database.svelte';

    interface Props {
        bindKey: 'textScreenColor' | 'textScreenBorder';
        labelKey: string;
        defaultColor?: string;
    }

    let { bindKey, labelKey, defaultColor = '#121212' }: Props = $props();

    function getLabel(): string {
        return (language as any)[labelKey] ?? labelKey;
    }

    // Get the current value
    let currentValue = $derived((DBState.db as any)[bindKey] as string | null);
</script>

{#if currentValue}
    <div class="flex items-center mt-2">
        <Check check={true} onChange={() => {
            (DBState.db as any)[bindKey] = null
        }} name={getLabel()} hiddenName/>
        <input type="color" class="style2 text-sm mr-2" bind:value={(DBState.db as any)[bindKey]} >
        <span>{getLabel()}</span>
    </div>
{:else}
    <div class="flex items-center mt-2">
        <Check check={false} onChange={() => {
            (DBState.db as any)[bindKey] = defaultColor
        }} name={getLabel()}/>
    </div>
{/if}
