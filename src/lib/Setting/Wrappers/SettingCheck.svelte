<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getConflictMessages, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import Check from 'src/lib/UI/GUI/CheckInput.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import ConflictBadge from 'src/lib/Setting/ConflictBadge.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let conflictMessages = $derived(getConflictMessages(item, ctx));

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));

    // Sync: DB → local (one-way read)
    $effect(() => {
        localValue = getSettingValue(item, ctx);
    });

    // Write-back: local → DB (guarded — only fires on actual user changes)
    $effect(() => {
        const val = localValue;
        if (val === UNINITIALIZED) return;
        untrack(() => {
            if (val !== getSettingValue(item, ctx)) {
                setSettingValue(item, val, ctx);
            }
        });
    });
</script>

<div class="flex items-center {item.classes ?? 'mt-2'}">
    <Check bind:check={localValue} name={getLabel(item)} disabled={conflictMessages.length > 0}>
        {#if item.showExperimental}<Help key="experimental"/>{/if}
        {#if item.helpKey}<Help key={item.helpKey as any} unrecommended={item.helpUnrecommended ?? false}/>{/if}
        {#if conflictMessages.length > 0}<ConflictBadge name={getLabel(item)} reasons={conflictMessages}/>{/if}
    </Check>
</div>
