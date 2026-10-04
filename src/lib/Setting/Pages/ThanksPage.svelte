<script lang="ts">
    import { ChevronRightIcon, GiftIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { openURL } from "src/ts/globalApi.svelte";

    interface supporterL{
        amount: number,
        name: string,
    }

    type Metal = 'gold' | 'silver' | 'copper' | 'bronze'

    interface Tier {
        label: string,
        min: number,
        max: number,
        metal: Metal,
        size: 'xl' | 'lg' | 'md' | 'sm',
    }

    interface FilledTier extends Tier {
        names: string[],
    }

    const tiers: Tier[] = [
        { label: 'Supporter V', min: 50, max: Infinity, metal: 'gold', size: 'xl' },
        { label: 'Supporter IV', min: 20, max: 50, metal: 'silver', size: 'lg' },
        { label: 'Supporter III', min: 10, max: 20, metal: 'silver', size: 'md' },
        { label: 'Supporter II', min: 5, max: 10, metal: 'copper', size: 'sm' },
        { label: 'Supporter I', min: -Infinity, max: 5, metal: 'bronze', size: 'sm' },
    ]

    async function loadSupporters(): Promise<FilledTier[]> {
        const supp = await fetch("https://sv.risuai.xyz/patreon/list")
        const list = await supp.json() as supporterL[]
        return tiers.map((tier) => ({
            ...tier,
            names: list.filter((v) => v.amount >= tier.min && v.amount < tier.max).map((v) => v.name),
        }))
    }

    const supporters = loadSupporters()
</script>

<div class="flex flex-col gap-4 w-full max-w-3xl mt-2 mb-4">
    <div class="flex flex-col gap-1">
        <h2 class="text-2xl font-bold">{language.supporterThanks}</h2>
        <span class="text-textcolor2">{language.supporterThanksDesc}</span>
    </div>

    <div class="flex flex-col items-start gap-2">
        <div class="flex flex-wrap items-center gap-2">
            <button class="h-12 w-44" onclick={() => {
                openURL("https://www.patreon.com/RisuAI")
            }}>
                <img src="https://c5.patreon.com/external/logo/become_a_patron_button.png" alt="patreon button" class="w-full h-full"/>
            </button>
            <button class="h-12 px-4 flex items-center gap-2 rounded-md border border-darkborderc bg-darkbutton hover:bg-selected text-textcolor text-sm font-semibold transition-colors" onclick={() => {
                openURL("https://www.patreon.com/RisuAI/posts/save-size-107543036")
            }}>
                <GiftIcon size={18} />
                <span>Get Patreon Benefit</span>
            </button>
        </div>
        <button class="group flex flex-wrap items-center gap-x-1.5 text-sm text-textcolor2" onclick={() => {
            openURL("https://sv.risuai.xyz/patreon")
        }}>
            <span>{language.supporterRegisterAsk}</span>
            <span class="flex items-center font-semibold text-textcolor underline-offset-4 group-hover:underline">
                {language.supporterRegisterAction}
                <ChevronRightIcon size={16} class="transition-transform group-hover:translate-x-0.5" />
            </span>
        </button>
    </div>

    {#await supporters}
        <span class="text-textcolor2 text-sm">{language.loading}...</span>
    {:then list}
        {#each list as tier (tier.label)}
            {#if tier.names.length > 0}
                <section class="tier tier-{tier.metal} flex flex-col gap-2 mt-2">
                    <header class="flex items-center gap-2">
                        <span class="tier-dot"></span>
                        <h3 class="font-bold text-textcolor">{tier.label}</h3>
                        <span class="text-xs text-textcolor2 bg-textcolor/5 rounded-full px-2 py-0.5">{tier.names.length}</span>
                    </header>
                    <div class="flex flex-wrap gap-2">
                        {#each tier.names as name, i (i)}
                            <span class="chip chip-{tier.size}">
                                <span class="metal-text">{name}</span>
                            </span>
                        {/each}
                    </div>
                </section>
            {/if}
        {/each}
    {:catch}
        <span class="text-textcolor2 text-sm">Failed to load supporters.</span>
    {/await}
</div>

<style>
    /* Metal stops are mixed with the theme text color so they stay legible on light and dark themes */
    .tier-gold   { --tier: #d4af37; --metal: linear-gradient(135deg, var(--m-edge) 0%, var(--m-mid) 50%, var(--m-edge) 100%); --m-edge: color-mix(in srgb, #b08a1a 80%, var(--risu-theme-textcolor)); --m-mid: color-mix(in srgb, #ecc65a 80%, var(--risu-theme-textcolor)); }
    .tier-silver { --tier: #a7adb7; --metal: linear-gradient(135deg, var(--m-edge) 0%, var(--m-mid) 50%, var(--m-edge) 100%); --m-edge: color-mix(in srgb, #7d8590 70%, var(--risu-theme-textcolor)); --m-mid: color-mix(in srgb, #d4d9e0 65%, var(--risu-theme-textcolor)); }
    .tier-copper { --tier: #b87333; --metal: linear-gradient(135deg, var(--m-edge) 0%, var(--m-mid) 50%, var(--m-edge) 100%); --m-edge: color-mix(in srgb, #9a5a22 80%, var(--risu-theme-textcolor)); --m-mid: color-mix(in srgb, #e0a46a 80%, var(--risu-theme-textcolor)); }
    .tier-bronze { --tier: #a08a5c; --metal: linear-gradient(135deg, var(--m-edge) 0%, var(--m-mid) 50%, var(--m-edge) 100%); --m-edge: color-mix(in srgb, #85704a 80%, var(--risu-theme-textcolor)); --m-mid: color-mix(in srgb, #cdb88c 80%, var(--risu-theme-textcolor)); }

    .tier-dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 9999px;
        background: var(--metal, var(--tier));
    }

    .chip {
        position: relative;
        overflow: hidden;
        max-width: 100%;
        border-radius: 0.375rem;
        border: 1px solid color-mix(in srgb, var(--tier) 30%, transparent);
        background: color-mix(in srgb, var(--tier) 7%, transparent);
        overflow-wrap: anywhere;
    }
    .chip-xl { padding: 0.625rem 1rem; font-size: 1.25rem; font-weight: 800; }
    .chip-lg { padding: 0.5rem 0.875rem; font-size: 1.125rem; font-weight: 800; }
    .chip-md { padding: 0.375rem 0.75rem; font-size: 1rem; font-weight: 700; }
    .chip-sm { padding: 0.25rem 0.625rem; font-size: 0.875rem; font-weight: 600; }

    /* Static gradient sized to the text box, so long names get the full highlight */
    .metal-text {
        display: inline-block;
        max-width: 100%;
        color: var(--risu-theme-textcolor);
    }
    .tier-gold .metal-text,
    .tier-silver .metal-text,
    .tier-copper .metal-text,
    .tier-bronze .metal-text {
        color: transparent;
        background: var(--metal);
        background-size: 100% 100%;
        background-clip: text;
        -webkit-background-clip: text;
    }

    /* Shimmer is a transform-only sweep over the chip: composited, no repaints */
    .chip::after {
        content: "";
        position: absolute;
        inset: 0;
        width: 50%;
        background: linear-gradient(100deg, transparent 0%, color-mix(in srgb, var(--tier) 22%, rgba(255, 255, 255, 0.16)) 50%, transparent 100%);
        transform: translateX(-100%);
        animation: sweep 3.5s ease-in-out infinite;
        pointer-events: none;
    }
    @keyframes sweep {
        0% { transform: translateX(-100%); }
        45%, 100% { transform: translateX(200%); }
    }
    @media (prefers-reduced-motion: reduce) {
        .chip::after { animation: none; display: none; }
    }
</style>
