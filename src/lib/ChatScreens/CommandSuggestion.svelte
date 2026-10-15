<script lang="ts">
    import { SquareSlashIcon } from "@lucide/svelte";
    import type { Component } from "svelte";
    import { language } from "src/lang";
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
    <div class="absolute bottom-full left-4 right-2 mb-2 z-30 flex max-h-80 overflow-hidden bg-darkbg border border-darkborderc rounded-lg shadow-xl">
        <div class="flex flex-col items-center gap-1 p-2 border-r border-darkborderc shrink-0">
            {#each sections as section (section.id)}
                {@const Icon = sectionIcons[section.id]}
                <button
                    class="w-9 h-9 flex items-center justify-center rounded-md transition-colors {section.id === activeSectionId ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:bg-textcolor/5 hover:text-textcolor'}"
                    title={section.label()}
                    aria-label={section.label()}
                    onmousedown={(e) => e.preventDefault()}
                    onclick={() => jumpToSection(section.id)}
                >
                    <Icon size={20} />
                </button>
            {/each}
        </div>

        <div class="flex flex-col flex-1 min-w-0">
            <div bind:this={listEle} class="flex-1 overflow-y-auto p-2" role="listbox">
                {#each sections as section (section.id)}
                    {@const Icon = sectionIcons[section.id]}
                    {@const startIndex = sectionStartIndex(section.id)}
                    <div data-command-section={section.id} class="sticky top-0 z-10 flex items-center gap-1.5 px-3 pt-1 pb-2 bg-darkbg text-xs font-semibold uppercase tracking-wider text-textcolor2">
                        <Icon size={14} />
                        {section.label()}
                    </div>
                    {#each section.commands as command, j (command.name)}
                        {@const i = startIndex + j}
                        <button
                            class="w-full flex flex-col items-start gap-1 px-3 py-2.5 rounded-md text-left transition-colors scroll-mt-9"
                            class:bg-selected={i === selectedIndex}
                            data-command-index={i}
                            role="option"
                            aria-selected={i === selectedIndex}
                            onmousedown={(e) => e.preventDefault()}
                            onmouseenter={() => selectedIndex = i}
                            onclick={() => onselect(command)}
                        >
                            <span class="flex items-center gap-2 flex-wrap">
                                <span class="font-semibold text-textcolor">/{command.name}</span>
                                {#if command.usage}
                                    <span class="px-1.5 py-0.5 rounded bg-textcolor/5 font-mono text-xs text-textcolor2">{command.usage}</span>
                                {/if}
                            </span>
                            <span class="text-sm text-textcolor2">{command.description()}</span>
                        </button>
                    {/each}
                {/each}
            </div>

            <div class="hidden sm:flex items-center gap-4 px-4 py-2 border-t border-darkborderc text-xs text-textcolor2">
                <span class="flex items-center gap-1.5"><kbd class="px-1.5 rounded border border-darkborderc leading-5">↑</kbd><kbd class="px-1.5 rounded border border-darkborderc leading-5">↓</kbd>{language.chatCommandUI.navigate}</span>
                <span class="flex items-center gap-1.5"><kbd class="px-1.5 rounded border border-darkborderc leading-5">Tab</kbd>{language.chatCommandUI.complete}</span>
                <span class="flex items-center gap-1.5"><kbd class="px-1.5 rounded border border-darkborderc leading-5">Esc</kbd>{language.chatCommandUI.close}</span>
            </div>
        </div>
    </div>
{/if}

