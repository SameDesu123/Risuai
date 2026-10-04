<script lang="ts">
    import { AwardIcon, CrownIcon, GemIcon, HeartIcon, MedalIcon, RefreshCwIcon, UserPlusIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { openURL } from "src/ts/globalApi.svelte";

    type TierKey = 'I' | 'II' | 'III' | 'IV' | 'V'
    type supporters = Record<TierKey, string[]>

    interface supporterL{
        amount: number,
        name: string,
    }

    // Ordered from the highest tier to the lowest
    const tiers = [
        { key: 'V', icon: CrownIcon, tone: 'gold', layout: 'hero' },
        { key: 'IV', icon: GemIcon, tone: 'silver', layout: 'card' },
        { key: 'III', icon: AwardIcon, tone: 'silver', layout: 'tile' },
        { key: 'II', icon: MedalIcon, tone: 'copper', layout: 'chip' },
        { key: 'I', icon: HeartIcon, tone: 'copper', layout: 'chip-sm' },
    ] as const

    async function loadSupporters() {

        const supp = await fetch("https://sv.risuai.xyz/patreon/list")
        if(!supp.ok){
            throw new Error(`HTTP ${supp.status}`)
        }

        const list = await supp.json() as supporterL[]
        const thanks:supporters = {
            //random names
            I: list.filter((v) => v.amount < 5).map((v) => v.name),
            II: list.filter((v) => v.amount >= 5 && v.amount < 10).map((v) => v.name),
            III: list.filter((v) => v.amount >= 10 && v.amount < 20).map((v) => v.name),
            IV: list.filter((v) => v.amount >= 20 && v.amount < 50).map((v) => v.name),
            V: list.filter((v) => v.amount >= 50).map((v) => v.name),
        }
        return thanks
    }

    let supportersPromise = $state(loadSupporters())
</script>

<div class="flex flex-col gap-8 w-full max-w-4xl mt-2 mb-8">

    <!-- Hero -->
    <section class="thanks-hero relative overflow-hidden rounded-2xl border border-darkborderc bg-darkbg p-6 md:p-8">
        <div class="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
            <div class="flex items-start gap-4">
                <div class="flex size-12 shrink-0 items-center justify-center rounded-xl bg-[#FF424D]/15 text-[#FF424D]">
                    <HeartIcon size={24} fill="currentColor" />
                </div>
                <div class="flex flex-col gap-1">
                    <h2 class="text-2xl font-bold text-textcolor">{language.supporterThanks}</h2>
                    <p class="text-sm text-textcolor2">{language.supporterThanksDesc}</p>
                </div>
            </div>
            <div class="flex flex-wrap gap-2">
                <button
                    class="inline-flex items-center gap-2 rounded-full bg-[#FF424D] px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-[#FF424D]/20 transition hover:brightness-110 active:scale-[0.98]"
                    onclick={() => {
                        openURL("https://www.patreon.com/RisuAI")
                    }}
                >
                    <HeartIcon size={16} />
                    {language.supporterBecomePatron}
                </button>
                <button
                    class="inline-flex items-center gap-2 rounded-full border border-darkborderc px-5 py-2.5 text-sm font-semibold text-textcolor transition hover:bg-selected active:scale-[0.98]"
                    onclick={() => {
                        openURL("https://sv.risuai.xyz/patreon")
                    }}
                >
                    <UserPlusIcon size={16} />
                    {language.supporterAddName}
                </button>
            </div>
        </div>
        <p class="relative mt-5 border-t border-darkborderc pt-4 text-xs text-textcolor2">{language.donatorPatreonDesc}</p>
    </section>

    <!-- Supporters -->
    {#await supportersPromise}
        <div class="flex flex-col gap-6" aria-busy="true" aria-label={language.loading}>
            {#each [3, 6, 12] as count}
                <div class="flex flex-col gap-3">
                    <div class="h-6 w-40 animate-pulse rounded-md bg-darkbutton"></div>
                    <div class="flex flex-wrap gap-2">
                        {#each Array(count) as _}
                            <div class="h-10 w-28 animate-pulse rounded-lg bg-darkbutton"></div>
                        {/each}
                    </div>
                </div>
            {/each}
        </div>

    {:then supporter}
        {#each tiers as tier}
            {@const names = supporter[tier.key]}
            {#if names.length > 0}
                <section class="flex flex-col gap-3">
                    <header class="flex items-center gap-3">
                        <div class="tier-icon tier-{tier.tone} flex size-8 items-center justify-center rounded-lg">
                            <tier.icon size={16} />
                        </div>
                        <h3 class="text-lg font-bold text-textcolor">Supporter {tier.key}</h3>
                        <span class="rounded-full bg-darkbutton px-2 py-0.5 text-xs font-medium text-textcolor2">{names.length}</span>
                        <div class="h-px flex-1 bg-darkborderc"></div>
                    </header>

                    {#if tier.layout === 'hero'}
                        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            {#each names as name}
                                <div class="tier-border tier-{tier.tone} rounded-2xl p-px">
                                    <div class="flex h-full items-center justify-center rounded-[15px] bg-darkbg px-6 py-6">
                                        <span class="prism-font prism-{tier.tone} text-center text-2xl font-black wrap-anywhere">{name}</span>
                                    </div>
                                </div>
                            {/each}
                        </div>
                    {:else if tier.layout === 'card'}
                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                            {#each names as name}
                                <div class="tier-border tier-{tier.tone} rounded-xl p-px">
                                    <div class="flex h-full items-center justify-center rounded-[11px] bg-darkbg px-5 py-4">
                                        <span class="prism-font prism-{tier.tone} text-center text-xl font-black wrap-anywhere">{name}</span>
                                    </div>
                                </div>
                            {/each}
                        </div>
                    {:else if tier.layout === 'tile'}
                        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                            {#each names as name}
                                <div class="flex items-center justify-center rounded-lg border border-darkborderc bg-darkbg px-3 py-3 transition hover:border-borderc">
                                    <span class="prism-font prism-{tier.tone} text-center text-base font-bold wrap-anywhere">{name}</span>
                                </div>
                            {/each}
                        </div>
                    {:else}
                        <div class="flex flex-wrap gap-2">
                            {#each names as name}
                                <span
                                    class="rounded-full border border-darkborderc bg-darkbg font-medium text-textcolor wrap-anywhere transition hover:border-borderc"
                                    class:px-3={tier.layout === 'chip'}
                                    class:py-1.5={tier.layout === 'chip'}
                                    class:text-sm={tier.layout === 'chip'}
                                    class:px-2.5={tier.layout === 'chip-sm'}
                                    class:py-1={tier.layout === 'chip-sm'}
                                    class:text-xs={tier.layout === 'chip-sm'}
                                >{name}</span>
                            {/each}
                        </div>
                    {/if}
                </section>
            {/if}
        {/each}

    {:catch}
        <div class="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-darkborderc px-6 py-10 text-center">
            <p class="text-sm text-textcolor2">{language.supporterLoadFailed}</p>
            <button
                class="inline-flex items-center gap-2 rounded-full border border-darkborderc px-4 py-2 text-sm font-medium text-textcolor transition hover:bg-selected"
                onclick={() => {
                    supportersPromise = loadSupporters()
                }}
            >
                <RefreshCwIcon size={14} />
                {language.supporterRetry}
            </button>
        </div>
    {/await}
</div>


<style>
    .thanks-hero::before{
        content: "";
        position: absolute;
        inset: 0;
        background:
            radial-gradient(circle at 0% 0%, rgb(255 66 77 / 0.14), transparent 55%),
            radial-gradient(circle at 100% 100%, rgb(212 175 50 / 0.10), transparent 50%);
        pointer-events: none;
    }

    .tier-gold{ --tier-a: #D4AF32; --tier-b: #F7E7A1; }
    .tier-silver{ --tier-a: #9CA3AF; --tier-b: #F3F4F6; }
    .tier-copper{ --tier-a: #B87333; --tier-b: #F1C9A5; }

    .tier-icon{
        color: var(--tier-a);
        background: color-mix(in srgb, var(--tier-a) 15%, transparent);
    }

    .tier-border{
        background: linear-gradient(135deg, var(--tier-a), color-mix(in srgb, var(--tier-a) 20%, transparent) 50%, var(--tier-a));
        transition: box-shadow 0.2s, transform 0.2s;
    }
    .tier-border:hover{
        box-shadow: 0 8px 24px -8px var(--tier-a);
        transform: translateY(-1px);
    }

    .prism-silver{
        background-image: linear-gradient(110deg, #888 0%, #888 40%, #fff 50%, #888 60%, #888 100%);
    }
    .prism-gold{
        background-image: linear-gradient(110deg, #D4AF32 0%, #D4AF32 40%, #fff6cc 50%, #D4AF32 60%, #D4AF32 100%);
    }
    .prism-copper{
        background-image: linear-gradient(110deg, #B87333 0%, #B87333 40%, #ffe0c2 50%, #B87333 60%, #B87333 100%);
    }

    .prism-font{
        color: transparent;
        background-size: 250% 100%;
        background-clip: text;
        -webkit-background-clip: text;
        animation: shimmer 3s linear infinite;
    }

    @keyframes shimmer {
        0% {
            background-position: 100% 0;
        }
        100% {
            background-position: 0% 0;
        }
    }

    @media (prefers-reduced-motion: reduce){
        .prism-font{
            animation: none;
            background-position: 50% 0;
        }
        .tier-border:hover{
            transform: none;
        }
    }
</style>
