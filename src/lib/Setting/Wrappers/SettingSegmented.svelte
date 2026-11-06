<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import SegmentedControl from 'src/lib/UI/GUI/SegmentedControl.svelte';
    import Help from 'src/lib/Others/Help.svelte';
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import SettingConflictIcon from '../SettingConflictIcon.svelte';
    import { getActiveConflicts } from 'src/ts/setting/conflicts';
    import SettingDisabledScope from '../SettingDisabledScope.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();

    // Transform options: filter by condition + resolve labelKey translations
    let processedOptions = $derived((item.options?.segmentOptions ?? [])
        .filter(opt => !opt.condition || opt.condition(ctx))
        .map(opt => ({
            value: opt.value,
            label: opt.labelKey ? ((language as any)[opt.labelKey] ?? opt.label ?? '') : (opt.label ?? '')
        })));

    // Reset value if current selection becomes hidden due to condition changes
    $effect(() => {
        const currentVal = getSettingValue(item, ctx);
        if (processedOptions.length > 0 && currentVal !== undefined && !processedOptions.some(o => o.value === currentVal)) {
            const numericOptions = processedOptions.filter((o): o is { value: number; label: string } => typeof o.value === 'number');
            const fallback = typeof currentVal === 'number' && numericOptions.length > 0
                ? numericOptions.reduce((closest, option) => Math.abs(option.value - currentVal) < Math.abs(closest.value - currentVal) ? option : closest).value
                : processedOptions[processedOptions.length - 1].value;
            setSettingValue(item, fallback, ctx);
        }
    });

    let conflicts = $derived(getActiveConflicts(item, ctx));
    let disabled = $derived(conflicts.length > 0);
</script>

<span class="{disabled ? 'text-textcolor2' : 'text-textcolor'} {item.classes ?? ''}">
    {getLabel(item)}
    {#if item.showExperimental}<Help key="experimental"/>{/if}
    {#if item.helpKey}<Help key={item.helpKey as any} unrecommended={item.helpUnrecommended ?? false}/>{/if}
    <SettingConflictIcon {conflicts} />
</span>
<SettingDisabledScope {disabled}>
<SegmentedControl
    bind:value={(DBState.db as any)[item.bindKey]}
    options={processedOptions}
/>
</SettingDisabledScope>
