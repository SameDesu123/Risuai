<script lang="ts">
    import { language } from "src/lang";
    import type { HeatLevel, Heatmap, HeatmapCell } from "src/ts/usage/aggregate";
    import type { UsageFormat } from "src/ts/usage/format";

    interface Props {
        heatmap: Heatmap
        format: UsageFormat
        selectedDay: string | null
        /** A second tooltip line. Only worked out for the day under the pointer. */
        detail?: (day: string) => string
        onSelect: (day: string) => void
    }

    let { heatmap, format, selectedDay, detail, onSelect }: Props = $props()

    // An 11px cell plus a 3px gap, as in GitHub's contribution graph.
    const step = 14

    const shades: Record<HeatLevel, string> = {
        0: 'bg-textcolor/10',
        1: 'bg-borderc/35',
        2: 'bg-borderc/60',
        3: 'bg-borderc/85',
        4: 'bg-borderc',
    }
    const levels: HeatLevel[] = [0, 1, 2, 3, 4]

    // Rows start on Sunday, and like GitHub only Monday, Wednesday and Friday are named.
    // January 4, 2026 was a Sunday.
    const weekdays = $derived(
        Array.from({ length: 7 }, (_, row) => (row % 2 === 1 ? format.weekday(new Date(2026, 0, 4 + row)) : ''))
    )

    const label = (cell: HeatmapCell) => `${format.day(cell.day)} · ${language.usage.tokenCount(format.tokens(cell.tokens))}`

    let host: HTMLDivElement
    let scroller: HTMLDivElement
    let hostWidth = $state(0)
    let tipWidth = $state(0)
    let tip = $state<{ cell: HeatmapCell, x: number, y: number } | null>(null)

    function showTip(event: Event, cell: HeatmapCell) {
        const target = (event.currentTarget as HTMLElement).getBoundingClientRect()
        const box = host.getBoundingClientRect()
        tip = { cell, x: target.left - box.left + target.width / 2, y: target.top - box.top }
    }

    // Start at the latest weeks, which is what a narrow screen should show first.
    let scrolledToEnd = false
    $effect(() => {
        if(!scrolledToEnd && heatmap.weeks.length > 0){
            scroller.scrollLeft = scroller.scrollWidth
            scrolledToEnd = true
        }
    })
</script>

<div class="relative" bind:this={host} bind:clientWidth={hostWidth}>
    <div class="overflow-x-auto pb-1" bind:this={scroller} onscroll={() => { tip = null }}>
        <div class="inline-flex gap-1">
            <div class="sticky left-0 z-1 flex flex-col gap-[3px] bg-darkbg pt-[15px] pr-1 text-[10px] leading-[11px] text-textcolor2">
                {#each weekdays as weekday}
                    <span class="h-[11px]">{weekday}</span>
                {/each}
            </div>
            <div>
                <div class="relative h-[15px] text-[10px] text-textcolor2">
                    {#each heatmap.months as month (month.week)}
                        <span class="absolute top-0 whitespace-nowrap" style:left="{month.week * step}px">{format.month(month.date)}</span>
                    {/each}
                </div>
                <div class="flex gap-[3px]">
                    {#each heatmap.weeks as week (week[0].day)}
                        <div class="flex flex-col gap-[3px]">
                            {#each week as cell (cell.day)}
                                {#if cell.inPast}
                                    <button
                                        type="button"
                                        class="size-[11px] rounded-[2px] outline-none hover:ring-1 hover:ring-textcolor/60 focus-visible:ring-2 focus-visible:ring-textcolor {shades[cell.level]}"
                                        class:ring-2={cell.day === selectedDay}
                                        class:ring-textcolor={cell.day === selectedDay}
                                        aria-label={label(cell)}
                                        aria-pressed={cell.day === selectedDay}
                                        onclick={() => onSelect(cell.day)}
                                        onpointerenter={(event) => showTip(event, cell)}
                                        onpointerleave={() => { tip = null }}
                                        onfocus={(event) => showTip(event, cell)}
                                        onblur={() => { tip = null }}
                                    ></button>
                                {:else}
                                    <div class="size-[11px]"></div>
                                {/if}
                            {/each}
                        </div>
                    {/each}
                </div>
            </div>
        </div>
    </div>

    {#if tip}
        <div
            class="pointer-events-none absolute z-10 -translate-y-full whitespace-nowrap rounded-md border border-darkborderc bg-bgcolor px-2 py-1 text-xs shadow-lg"
            bind:offsetWidth={tipWidth}
            style:left="{Math.max(0, Math.min(tip.x - tipWidth / 2, hostWidth - tipWidth))}px"
            style:top="{tip.y - 6}px"
        >
            <div class="font-medium text-textcolor">{label(tip.cell)}</div>
            {#if detail}
                <div class="text-textcolor2">{detail(tip.cell.day)}</div>
            {/if}
        </div>
    {/if}

    <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-textcolor2">
        <span>{language.usage.heatmapHint}</span>
        <div class="ml-auto flex items-center gap-[3px]">
            <span class="mr-1">{language.usage.less}</span>
            {#each levels as level}
                <span class="size-[11px] rounded-[2px] {shades[level]}"></span>
            {/each}
            <span class="ml-1">{language.usage.more}</span>
        </div>
    </div>
</div>
