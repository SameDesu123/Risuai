<script lang="ts">
    import { Pipette, RotateCcw } from "@lucide/svelte";
    import { language } from "src/lang";
    import { folderBackground } from "src/ts/gui/folderAppearance";

    let {
        value = $bindable(""),
        label,
        background = false,
    }: {
        value: string;
        label: string;
        background?: boolean;
    } = $props();
    // Paired bright/muted columns keep neutral colors together.
    const colors = [
        ["#ffffff", "#263247"],
        ["#b8b8b8", "#525252"],
        ["#ff3b30", "#992b20"],
        ["#ff9500", "#995c00"],
        ["#ffdd00", "#898000"],
        ["#00c987", "#00785a"],
        ["#14b8a6", "#0f766e"],
        ["#00b5ef", "#007a99"],
        ["#1677ff", "#174ea6"],
        ["#4055ff", "#3730a3"],
        ["#a500ef", "#6200a0"],
        ["#ed00ad", "#96006c"],
        ["#ff8aba", "#864363"],
    ];
    let custom = $derived(Boolean(value) && !colors.flat().includes(value));
</script>

<fieldset>
    <legend>{label}</legend>
    <div class="palette">
        {#each colors as pair}
            <div class="pair">
                {#each pair as color}
                    <button
                        type="button"
                        class="swatch"
                        aria-label={`${label}: ${color}`}
                        aria-pressed={value === color}
                        style:--swatch={color}
                        onclick={() => (value = color)}
                    ></button>
                {/each}
            </div>
        {/each}
        <div class="pair">
            <label
                class="swatch custom"
                class:chosen={custom}
                title={language.folderSettings.customColor}
            >
                <span class="chip" style:background={custom ? folderBackground(value) : undefined}
                ></span>
                <Pipette size={18} />
                <input
                    type="color"
                    aria-label={`${label}: ${language.folderSettings.customColor}`}
                    value={/^#[\da-f]{6}$/i.test(value) ? value : "#4055ff"}
                    oninput={(event) => (value = event.currentTarget.value)}
                />
            </label>
            <button
                type="button"
                class="swatch reset"
                aria-label={`${label}: ${language.folderSettings.defaultColor}`}
                aria-pressed={!value}
                style:--swatch={background ? "var(--color-darkbg)" : "var(--color-textcolor)"}
                onclick={() => (value = "")}><RotateCcw size={15} /></button
            >
        </div>
    </div>
</fieldset>

<style>
    fieldset {
        min-width: 0;
    }
    legend {
        margin-bottom: 8px;
    }
    .palette {
        display: grid;
        grid-template-columns: repeat(14, minmax(0, 1fr));
        gap: 2px;
    }
    .pair {
        display: flex;
        flex-direction: column;
        gap: 2px;
    }
    .swatch {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 0;
        height: 38px;
        border-radius: 9px;
        cursor: pointer;
    }
    .swatch::before {
        content: "";
        position: absolute;
        inset: 4px;
        border-radius: 5px;
        background: var(--swatch);
        border: 1px solid #80808040;
    }
    .swatch[aria-pressed="true"]::before,
    .chosen::before {
        outline: 2px solid var(--color-textcolor);
        outline-offset: 2px;
    }
    .custom {
        --swatch: conic-gradient(#f44, #ff0, #0f9, #05f, #a0f, #f44);
    }
    .custom :global(svg),
    .reset :global(svg) {
        position: relative;
        color: #111;
        filter: drop-shadow(0 0 1px white);
        pointer-events: none;
    }
    .chip {
        position: absolute;
        right: 5px;
        bottom: 5px;
        width: 9px;
        height: 9px;
        border-radius: 50%;
    }
    input {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
    }
    .swatch:focus-visible,
    .swatch:focus-within {
        outline: 2px solid var(--color-textcolor2);
        outline-offset: 1px;
    }
    @media (pointer: coarse), (max-width: 600px) {
        .palette {
            display: flex;
            gap: 0;
            flex-wrap: wrap;
        }
        .pair {
            flex: 0 0 14.2857%;
        }
        .swatch {
            min-height: 44px;
        }
    }
</style>
