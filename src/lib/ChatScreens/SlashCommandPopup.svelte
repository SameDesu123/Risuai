<script lang="ts">
    import { language } from "src/lang";
    import type { SlashCommandEntry } from "src/ts/process/slashCommands";

    interface Props {
        // Commands to choose from; empty when only a hint is shown
        commands: SlashCommandEntry[];
        // Command whose usage is shown while typing its arguments
        hint?: SlashCommandEntry | null;
        selected?: number;
        onSelect?: (command: SlashCommandEntry) => void;
    }

    let { commands, hint = null, selected = $bindable(0), onSelect = () => {} }: Props = $props();

    let listEle: HTMLDivElement | undefined = $state();

    function sourceLabel(command: SlashCommandEntry) {
        const label = language.slashCommandSource[command.source];
        return command.sourceName ? `${label} · ${command.sourceName}` : label;
    }

    $effect(() => {
        const item = listEle?.querySelector(`[data-index="${selected}"]`);
        item?.scrollIntoView({ block: 'nearest' });
    });
</script>

{#if commands.length > 0}
    <div
        bind:this={listEle}
        class="absolute bottom-full left-4 right-4 mb-1 z-30 max-h-64 overflow-y-auto rounded-md border border-darkborderc bg-darkbg shadow-lg"
        role="listbox"
        aria-label={language.slashCommand}
    >
        {#each commands as command, i (command.source + command.name)}
            <button
                type="button"
                class="w-full flex items-start gap-3 px-3 py-2 text-left transition-colors"
                class:bg-selected={i === selected}
                data-index={i}
                role="option"
                aria-selected={i === selected}
                onmousedown={(e) => {
                    // keep focus in the textarea
                    e.preventDefault();
                    onSelect(command);
                }}
                onmouseenter={() => {
                    selected = i;
                }}
            >
                <div class="flex flex-col min-w-0 grow">
                    <span class="text-textcolor font-mono text-sm truncate">{command.usage}</span>
                    {#if command.description}
                        <span class="text-textcolor2 text-xs truncate">{command.description}</span>
                    {/if}
                </div>
                <span class="shrink-0 text-textcolor2 text-xs mt-0.5">{sourceLabel(command)}</span>
            </button>
        {/each}
    </div>
{:else if hint}
    <div class="absolute bottom-full left-4 right-4 mb-1 z-30 rounded-md border border-darkborderc bg-darkbg px-3 py-2 shadow-lg pointer-events-none">
        <span class="text-textcolor font-mono text-sm">{hint.usage}</span>
        {#if hint.description}
            <span class="text-textcolor2 text-xs ml-2">{hint.description}</span>
        {/if}
    </div>
{/if}
