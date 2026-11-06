<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import ColorInput from 'src/lib/UI/GUI/ColorInput.svelte';
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

<div class="flex items-center {item.classes ?? 'mt-2'}">
    <SettingDisabledScope {disabled}>
        <ColorInput bind:value={localValue} nullable={item.options?.nullable ?? false} />
    </SettingDisabledScope>
    <span class="ml-2"><span class:opacity-50={disabled}>{getLabel(item)}</span> <SettingConflictIcon {conflicts} /></span>
</div>
