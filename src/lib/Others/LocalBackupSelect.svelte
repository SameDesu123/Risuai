<script lang="ts">
    import { CheckIcon, ChevronDownIcon, ChevronRightIcon, MinusIcon } from "@lucide/svelte";
    import { SvelteSet } from "svelte/reactivity";
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import {
        getLocalBackupTreeSections,
        localBackupSections,
        localBackupTree,
        normalizeLocalBackupSections,
        type LocalBackupGroup,
        type LocalBackupSection,
        type LocalBackupTreeNode,
    } from "src/ts/drive/backuplocalData";

    interface Props {
        onConfirm: (sections: LocalBackupSection[]) => void
        onCancel: () => void
    }

    let { onConfirm, onCancel }: Props = $props()

    const selected = new SvelteSet<LocalBackupSection>(localBackupSections)
    const collapsed = new SvelteSet<LocalBackupGroup>()

    type CheckState = 'checked' | 'unchecked' | 'mixed'

    function getCheckState(node: LocalBackupTreeNode): CheckState {
        const sections = getLocalBackupTreeSections(node)
        const count = sections.filter((section) => selected.has(section)).length
        if (count === 0) {
            return 'unchecked'
        }
        return count === sections.length ? 'checked' : 'mixed'
    }

    function toggle(node: LocalBackupTreeNode) {
        //a partly selected group becomes fully selected, like most tree checkboxes
        const select = getCheckState(node) !== 'checked'
        for (const section of getLocalBackupTreeSections(node)) {
            if (select) {
                selected.add(section)
            } else {
                selected.delete(section)
            }
        }
    }

    function toggleCollapsed(group: LocalBackupGroup) {
        if (collapsed.has(group)) {
            collapsed.delete(group)
        } else {
            collapsed.add(group)
        }
    }

    //characters without some of their assets restore with missing images
    const missingCharacterAssets = $derived(
        selected.has('characters') && (!selected.has('characterProfileImages') || !selected.has('characterAssets'))
    )
</script>

{#snippet treeNode(node: LocalBackupTreeNode)}
    {@const checkState = getCheckState(node)}
    {@const description = language.localBackupTreeDesc[node.id]}
    <div class="flex items-start gap-1 py-1">
        {#if 'children' in node}
            <button
                class="w-6 h-6 shrink-0 flex justify-center items-center rounded-md text-textcolor2 hover:text-textcolor hover:bg-textcolor/5 transition-colors"
                aria-expanded={!collapsed.has(node.id)}
                aria-label={language.localBackupTree[node.id]}
                onclick={() => toggleCollapsed(node.id)}
            >
                {#if collapsed.has(node.id)}
                    <ChevronRightIcon size={16} />
                {:else}
                    <ChevronDownIcon size={16} />
                {/if}
            </button>
        {:else}
            <span class="w-6 shrink-0" aria-hidden="true"></span>
        {/if}
        <button
            class="flex items-start gap-2 flex-1 min-w-0 text-left rounded-md py-0.5 px-1 hover:bg-textcolor/5 transition-colors"
            role="checkbox"
            aria-checked={checkState === 'mixed' ? 'mixed' : checkState === 'checked'}
            onclick={() => toggle(node)}
        >
            <span
                class="w-5 h-5 min-w-5 mt-0.5 rounded-md border-2 border-darkborderc flex justify-center items-center transition-colors duration-200 {checkState === 'unchecked' ? 'bg-darkbutton' : 'bg-darkborderc'}"
                aria-hidden="true"
            >
                {#if checkState === 'checked'}
                    <CheckIcon class="w-3 h-3 text-white" strokeWidth={3} />
                {:else if checkState === 'mixed'}
                    <MinusIcon class="w-3 h-3 text-white" strokeWidth={3} />
                {/if}
            </span>
            <span class="flex flex-col min-w-0">
                <span class:font-semibold={'children' in node}>{language.localBackupTree[node.id]}</span>
                {#if description}
                    <span class="text-textcolor2 text-sm">{description}</span>
                {/if}
            </span>
        </button>
    </div>
    {#if 'children' in node && !collapsed.has(node.id)}
        <div class="ml-3 pl-3 border-l border-darkborderc">
            {#each node.children as child (child.id)}
                {@render treeNode(child)}
            {/each}
        </div>
    {/if}
{/snippet}

<div class="w-2xl flex flex-col max-w-full">
    <h1 class="text-xl mb-2 font-bold">
        {language.saveBackupLocal}
    </h1>
    <span class="text-textcolor2 text-sm mb-2">{language.localBackupSelectDesc}</span>
    <div class="border border-darkborderc rounded-md p-2 mt-2 overflow-y-auto">
        {#each localBackupTree as node (node.id)}
            {@render treeNode(node)}
        {/each}
    </div>
    {#if missingCharacterAssets}
        <span class="text-draculared text-sm mt-2">{language.localBackupMissingCharacterAssets}</span>
    {/if}
    <div class="flex gap-2 w-full mt-4">
        <Button className="grow" styled="outlined" onclick={onCancel}>{language.cancel}</Button>
        <Button
            className="grow"
            disabled={selected.size === 0}
            onclick={() => {
                if (selected.size > 0) {
                    onConfirm(normalizeLocalBackupSections(selected))
                }
            }}
        >{language.localBackupSave}</Button>
    </div>
</div>
