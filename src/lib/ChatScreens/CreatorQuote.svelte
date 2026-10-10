<div class="flex w-full justify-center mt-4 max-w-100vw">
    <div class="w-5/6 max-w-80vw bg-darkbg rounded-md p-3 text-textcolor text-sm">
        <h1 class="font-bold mb-2">{language.creatorNotes}
            <button class="float-right" onclick={onRemove}>
                <XIcon />
            </button>
        </h1>
        {#if quote.length >= 2}
            <MultiLangDisplay value={quote} markdown={true} />
        {/if}
        {#if hasForks}
            {#if quote.length >= 2}
                <hr class="my-2 border-darkborderc" />
            {/if}
            <CardForkNotice {attribution} />
        {/if}
    </div>
</div>
<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import type { CardAttribution } from "src/ts/cardAttribution";
    import MultiLangDisplay from "../UI/GUI/MultiLangDisplay.svelte";
    import CardForkNotice from "../Others/CardForkNotice.svelte";

    interface Props {
        onRemove: () => void;
        quote: string;
        attribution?: CardAttribution;
    }

    let { onRemove, quote, attribution }: Props = $props();

    const hasForks = $derived((attribution?.forks?.length ?? 0) > 0);
</script>
