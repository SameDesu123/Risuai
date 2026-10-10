<script lang="ts">
    import { language } from "src/lang";
    import { attributionFingerprint, type CardAttribution } from "src/ts/cardAttribution";

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
        // Nameless creators are told apart by fingerprint.
        const name = original.name || `${language.originalCreatorUnknown} (${attributionFingerprint(original.id)})`;
        return { before, name, after };
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
