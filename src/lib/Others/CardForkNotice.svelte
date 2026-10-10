<script lang="ts">
    import { language } from "src/lang";
    import type { CardAttribution } from "src/ts/cardAttribution";

    interface Props {
        attribution?: CardAttribution;
    }

    let { attribution }: Props = $props();

    // Split the template around the placeholder so the creator name is rendered as a plain text node, never as HTML.
    const parts = $derived.by(() => {
        const original = attribution?.original;
        if (!original) {
            return null;
        }
        const [before, after = ''] = language.cardForkNotice.split('{{original}}');
        return { before, name: original.name || language.attributionAnonymous, after };
    });
</script>

{#if attribution && attribution.forks.length > 0}
    <p class="text-textcolor2 text-xs">
        {#if parts}
            {parts.before}<span class="font-semibold">{parts.name}</span>{parts.after}
        {:else}
            {language.cardForkNoticeUnknown}
        {/if}
    </p>
{/if}
