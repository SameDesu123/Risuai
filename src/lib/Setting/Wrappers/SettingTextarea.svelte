<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import SettingConflictIcon from '../SettingConflictIcon.svelte';
    import { getActiveConflicts } from 'src/ts/setting/conflicts';
    import SettingDisabledScope from '../SettingDisabledScope.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    let localValue: any = $state(untrack(() => getSettingValue(item, ctx)));

    // Sync: DB → local (one-way read)
    $effect(() => {
        localValue = getSettingValue(item, ctx);
    });

    // Write-back: local → DB (guarded)
    $effect(() => {
        const val = localValue;
        if (val === UNINITIALIZED) return;
        untrack(() => {
            if (val !== getSettingValue(item, ctx)) {
                setSettingValue(item, val, ctx);
            }
        });
    });

    let conflicts = $derived(getActiveConflicts(item, ctx));
    let disabled = $derived(conflicts.length > 0);
</script>

<span class="text-textcolor {item.classes ?? ''}">
    <span class:opacity-50={disabled}>{getLabel(item)}</span>
    {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
    <SettingConflictIcon {conflicts} />
</span>
<SettingDisabledScope {disabled}>
<TextAreaInput
    bind:value={localValue}
    placeholder={item.options?.placeholder}
/>
</SettingDisabledScope>
