<script lang="ts">
    import { getCommandSuggestions, type ChatCommandInfo } from "src/ts/process/commandList";

    interface Props {
        input: string;
        onselect: (command: ChatCommandInfo) => void;
    }

    let { input, onselect }: Props = $props();

    let selectedIndex = $state(0)
    let dismissed = $state(false)
    let listEle: HTMLDivElement | undefined = $state()

    const suggestions = $derived(getCommandSuggestions(input))
    const visible = $derived(!dismissed && !!suggestions && suggestions.length > 0)

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

    // Returns true when the key event was consumed by the suggestion list
    export function handleKeydown(e: KeyboardEvent): boolean {
        if(!visible || e.isComposing){
            return false
        }
        switch(e.key){
            case 'ArrowDown':
                selectedIndex = (selectedIndex + 1) % suggestions.length
                break
            case 'ArrowUp':
                selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length
                break
            case 'Tab':
                onselect(suggestions[selectedIndex])
                break
            case 'Enter':
                // an already complete command name falls through so it can be sent as is
                if(e.shiftKey || input.slice(1) === suggestions[selectedIndex].name){
                    return false
                }
                onselect(suggestions[selectedIndex])
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
    <div
        bind:this={listEle}
        class="absolute bottom-full left-4 right-2 mb-1 z-30 max-h-64 overflow-y-auto bg-darkbg border border-darkborderc rounded-md shadow-lg"
        role="listbox"
    >
        {#each suggestions as command, i (command.name)}
            <button
                class="w-full flex flex-col items-start px-3 py-2 text-left transition-colors"
                class:bg-selected={i === selectedIndex}
                class:hover:bg-selected={i !== selectedIndex}
                data-command-index={i}
                role="option"
                aria-selected={i === selectedIndex}
                onmousedown={(e) => e.preventDefault()}
                onmouseenter={() => selectedIndex = i}
                onclick={() => onselect(command)}
            >
                <span class="font-mono text-textcolor">
                    /{command.name}
                    {#if command.usage}
                        <span class="text-textcolor2">{command.usage}</span>
                    {/if}
                </span>
                <span class="text-sm text-textcolor2">{command.description()}</span>
            </button>
        {/each}
    </div>
{/if}
