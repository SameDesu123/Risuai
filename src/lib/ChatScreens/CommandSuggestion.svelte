<script lang="ts">
    import { SquareSlashIcon } from "@lucide/svelte";
    import type { Component } from "svelte";
    import SidebarIndicator from "../SideBars/SidebarIndicator.svelte";
    import { getCommandSuggestions, type ChatCommandInfo, type CommandSectionId } from "src/ts/process/commandList";

    interface Props {
        input: string;
        onselect: (command: ChatCommandInfo) => void;
    }

    let { input, onselect }: Props = $props();

    const sectionIcons: Record<CommandSectionId, Component> = {
        builtin: SquareSlashIcon,
    }

    let selectedIndex = $state(0)
    let dismissed = $state(false)
    let listEle: HTMLDivElement | undefined = $state()

    const sections = $derived(getCommandSuggestions(input))
    // flat list of every shown command, so keyboard navigation can cross sections
    const flatCommands = $derived((sections ?? []).flatMap((section) => section.commands.map((command) => ({ command, sectionId: section.id }))))
    const visible = $derived(!dismissed && flatCommands.length > 0)
    const activeSectionId = $derived(flatCommands[selectedIndex]?.sectionId)

    $effect(() => {
        // reset highlight whenever the typed command changes
        input
        selectedIndex = 0
        if(!input.startsWith('/')){
            dismissed = false
        }
    })

    $effect(() => {
        listEle?.querySelector(`[data-command-index="${selectedIndex}"]`)?.scrollIntoView({ block: 'nearest' })
    })

    function sectionStartIndex(sectionId: CommandSectionId) {
        return flatCommands.findIndex((c) => c.sectionId === sectionId)
    }

    function jumpToSection(sectionId: CommandSectionId) {
        selectedIndex = sectionStartIndex(sectionId)
        listEle?.querySelector(`[data-command-section="${sectionId}"]`)?.scrollIntoView({ block: 'start' })
    }

    // Returns true when the key event was consumed by the suggestion list
    export function handleKeydown(e: KeyboardEvent): boolean {
        if(!visible || e.isComposing){
            return false
        }
        const current = flatCommands[selectedIndex].command
        switch(e.key){
            case 'ArrowDown':
                selectedIndex = (selectedIndex + 1) % flatCommands.length
                break
            case 'ArrowUp':
                selectedIndex = (selectedIndex - 1 + flatCommands.length) % flatCommands.length
                break
            case 'Tab':
                onselect(current)
                break
            case 'Enter':
                // an already complete command name falls through so it can be sent as is
                if(e.shiftKey || input.slice(1) === current.name){
                    return false
                }
                onselect(current)
                break
            case 'Escape':
                dismissed = true
                break
            default:
                return false
        }
        e.preventDefault()
        return true
    }
</script>

{#if visible}
    <div class="absolute bottom-full left-4 right-2 mb-2 z-30 flex max-h-80 overflow-hidden bg-darkbg text-textcolor border border-darkborderc rounded-md shadow-lg">
        <div class="flex flex-col flex-1 min-w-0">
            <div bind:this={listEle} class="flex-1 overflow-y-auto px-2 pb-2" role="listbox">
                {#each sections as section (section.id)}
                    {@const startIndex = sectionStartIndex(section.id)}
                    <div data-command-section={section.id} class="sticky top-0 z-10 px-2 pt-2 pb-1 bg-darkbg text-sm text-textcolor2">
                        {section.label()}
                    </div>
                    {#each section.commands as command, j (command.name)}
                        {@const i = startIndex + j}
                        <button
                            class="w-full flex flex-col items-start gap-0.5 p-2 rounded-md text-left scroll-mt-9"
                            class:bg-selected={i === selectedIndex}
                            data-command-index={i}
                            role="option"
                            aria-selected={i === selectedIndex}
                            onmousedown={(e) => e.preventDefault()}
                            onmouseenter={() => selectedIndex = i}
                            onclick={() => onselect(command)}
                        >
                            <span class="flex items-center gap-2 flex-wrap">
                                <span class="text-textcolor">/{command.name}</span>
                                {#if command.usage}
                                    <span class="px-1.5 rounded-sm bg-darkbutton text-xs leading-5 text-textcolor2">{command.usage}</span>
                                {/if}
                            </span>
                            <span class="text-sm text-textcolor2">{command.description()}</span>
                        </button>
                    {/each}
                {/each}
            </div>
        </div>

        <div class="flex flex-col items-center gap-2 py-2 w-14 min-w-14 bg-bgcolor">
            {#each sections as section (section.id)}
                {@const Icon = sectionIcons[section.id]}
                <div class="group relative flex items-center justify-center w-full">
                    <!-- mirrored so the sidebar indicator sits on the right edge, next to the input bar buttons -->
                    <div class="absolute inset-0 flex items-center -scale-x-100 pointer-events-none">
                        <SidebarIndicator isActive={section.id === activeSectionId} />
                    </div>
                    <button
                        class="w-10 h-10 flex items-center justify-center rounded-md transition-colors {section.id === activeSectionId ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:text-textcolor'}"
                        title={section.label()}
                        aria-label={section.label()}
                        onmousedown={(e) => e.preventDefault()}
                        onclick={() => jumpToSection(section.id)}
                    >
                        <Icon size={20} />
                    </button>
                </div>
            {/each}
        </div>
    </div>
{/if}
