<script lang="ts">
    import { language } from 'src/lang';
    import { changeChar, getCharImage } from 'src/ts/characters';
    import {
        collectHomeStats,
        getRecentCharacters,
        type HomeScreenSettings,
        type HomeStats,
    } from 'src/ts/gui/homeScreen';
    import { DBState } from 'src/ts/stores.svelte';
    import { ActivityIcon, ChartColumnIcon, HistoryIcon } from '@lucide/svelte';

    interface Props {
        settings: HomeScreenSettings;
    }

    let { settings }: Props = $props();

    const weekCount = 20;
    const levelClasses = ['bg-textcolor/10', 'bg-borderc/35', 'bg-borderc/60', 'bg-borderc/80', 'bg-borderc'];
    const cardClass =
        'flex min-w-0 flex-col rounded-2xl border border-darkborderc/60 bg-darkbg p-4 text-left risu-card';
    const numberFormatter = new Intl.NumberFormat(navigator.languages);
    const dateFormatter = new Intl.DateTimeFormat(navigator.languages, { dateStyle: 'medium' });
    const agoFormatter = new Intl.RelativeTimeFormat(navigator.languages, { style: 'short' });

    let stats = $state<HomeStats | null>(null);
    let needsStats = $derived(settings.showActivity || settings.showStats);
    let recent = $derived(settings.showRecent ? getRecentCharacters(DBState.db.characters) : []);

    let sideCount = $derived((settings.showActivity ? 1 : 0) + (settings.showStats ? 1 : 0));
    let totalCount = $derived(sideCount + (settings.showRecent ? 1 : 0));

    $effect(() => {
        if (!needsStats || stats) {
            return;
        }
        // Let the home screen paint before walking every chat
        const timer = setTimeout(() => {
            stats = collectHomeStats(DBState.db.characters, Date.now(), weekCount);
        }, 0);
        return () => clearTimeout(timer);
    });

    function agoText(time: number) {
        const diff = Date.now() - time;
        if (diff < 3600000) {
            return agoFormatter.format(-Math.floor(diff / 60000), 'minute');
        }
        if (diff < 86400000) {
            return agoFormatter.format(-Math.floor(diff / 3600000), 'hour');
        }
        if (diff < 2592000000) {
            return agoFormatter.format(-Math.floor(diff / 86400000), 'day');
        }
        if (diff < 31536000000) {
            return agoFormatter.format(-Math.floor(diff / 2592000000), 'month');
        }
        return agoFormatter.format(-Math.floor(diff / 31536000000), 'year');
    }

    function spanClass(isRecent: boolean) {
        if (totalCount === 1) {
            return ' md:col-span-2';
        }
        if (isRecent && sideCount === 2) {
            return ' md:row-span-2';
        }
        return '';
    }
</script>

{#if totalCount > 0}
    <div class="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
        {#if settings.showRecent}
            <section class={cardClass + spanClass(true)}>
                <h2 class="flex items-center gap-2 text-sm font-semibold text-textcolor2">
                    <HistoryIcon size={16} />
                    {language.homeRecentChats}
                </h2>
                {#if recent.length === 0}
                    <p class="mt-3 text-sm text-textcolor2">{language.homeNoRecentChats}</p>
                {:else}
                    <ul class="mt-2 flex flex-col">
                        {#each recent as item (item.index)}
                            <li>
                                <button
                                    type="button"
                                    class="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-selected/60"
                                    onclick={() => changeChar(item.index)}
                                >
                                    {#await getCharImage(item.image, 'css')}
                                        <span class="h-10 w-10 shrink-0 rounded-lg bg-selected"></span>
                                    {:then style}
                                        <span class="h-10 w-10 shrink-0 rounded-lg bg-selected" style={style}></span>
                                    {/await}
                                    <span class="min-w-0 flex-1">
                                        <span class="block truncate text-textcolor">{item.name}</span>
                                        <span class="block text-xs text-textcolor2">{agoText(item.lastInteraction)}</span>
                                    </span>
                                </button>
                            </li>
                        {/each}
                    </ul>
                {/if}
            </section>
        {/if}

        {#if settings.showActivity}
            <section class={cardClass + spanClass(false)}>
                <h2 class="flex items-center gap-2 text-sm font-semibold text-textcolor2">
                    <ActivityIcon size={16} />
                    {language.homeActivity}
                </h2>
                <div
                    class="mt-3 grid w-full max-w-[24rem] grid-flow-col grid-rows-7 gap-[3px]"
                    style="grid-template-columns: repeat({weekCount}, minmax(0, 1fr));"
                >
                    {#if stats}
                        {#each stats.weeks as week}
                            {#each week as day}
                                <span
                                    class="aspect-square rounded-[3px] {levelClasses[day.level]}"
                                    class:invisible={day.future}
                                    title="{dateFormatter.format(day.time)} · {numberFormatter.format(day.count)}"
                                ></span>
                            {/each}
                        {/each}
                    {:else}
                        {#each { length: weekCount * 7 } as _}
                            <span class="aspect-square rounded-[3px] bg-textcolor/5"></span>
                        {/each}
                    {/if}
                </div>
                <div class="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-textcolor2">
                    <span>
                        {#if stats}
                            {language.homeActivitySummary
                                .replace('{count}', numberFormatter.format(stats.rangeMessages))
                                .replace('{weeks}', String(weekCount))}
                            {#if stats.streak > 0}
                                · {language.homeStreak.replace('{days}', numberFormatter.format(stats.streak))}
                            {/if}
                        {/if}
                    </span>
                    <span class="flex items-center gap-1">
                        {language.homeLess}
                        {#each levelClasses as levelClass}
                            <span class="h-2.5 w-2.5 rounded-[2px] {levelClass}"></span>
                        {/each}
                        {language.homeMore}
                    </span>
                </div>
            </section>
        {/if}

        {#if settings.showStats}
            <section class={cardClass + spanClass(false)}>
                <h2 class="flex items-center gap-2 text-sm font-semibold text-textcolor2">
                    <ChartColumnIcon size={16} />
                    {language.homeStats}
                </h2>
                <div class="mt-3 grid grid-cols-2 gap-2">
                    {#each [
                        [language.homeCharacters, stats?.characters],
                        [language.homeChats, stats?.chats],
                        [language.homeMessages, stats?.messages],
                        [language.homeThisMonth, stats?.monthMessages],
                    ] as [label, value]}
                        <div class="rounded-xl bg-bgcolor/60 px-3 py-2">
                            <div class="text-xs text-textcolor2">{label}</div>
                            <div class="text-xl font-semibold tabular-nums text-textcolor">
                                {value === undefined ? '-' : numberFormatter.format(value as number)}
                            </div>
                        </div>
                    {/each}
                </div>
                {#if stats?.topModel}
                    <div class="mt-3 flex min-w-0 gap-1 text-xs text-textcolor2">
                        <span class="shrink-0">{language.homeTopModel}:</span>
                        <span class="truncate text-textcolor" title={stats.topModel}>{stats.topModel}</span>
                    </div>
                {/if}
            </section>
        {/if}
    </div>
{/if}
