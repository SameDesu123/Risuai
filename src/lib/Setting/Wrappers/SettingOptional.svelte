<script lang="ts">
    import type { SettingItem, SettingContext } from 'src/ts/setting/types';
    import { UNINITIALIZED, getLabel, getSettingValue, setSettingValue } from 'src/ts/setting/utils';
    import { untrack } from 'svelte';
    import OptionalInput from 'src/lib/UI/GUI/OptionalInput.svelte';
    import Help from 'src/lib/Others/Help.svelte';

    interface Props {
        item: SettingItem;
        ctx: SettingContext;
    }

    let { item, ctx }: Props = $props();
    const uid = $props.id();

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
</script>

<span class="text-textcolor {item.classes ?? ''}">
    <label for="{uid}-input" id="{uid}-label">{getLabel(item)}</label>
    {#if item.helpKey}<Help key={item.helpKey as any}/>{/if}
</span>
<OptionalInput
    marginBottom={true}
    bind:value={localValue}
    id="{uid}-input"
    labelledby="{uid}-label"
    numberMode={item.options?.optionalMode === 'number'}
    boolMode={item.options?.optionalMode === 'bool'}
/>
