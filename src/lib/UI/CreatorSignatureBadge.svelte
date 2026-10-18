<script lang="ts">
    import { BadgeCheckIcon, PencilLineIcon, ShieldAlertIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState } from 'src/ts/stores.svelte';
    import { tooltip } from "src/ts/gui/tooltip";
    import { pickSignable, verifyChain, type CreatorSignature, type SignatureVerification } from "src/ts/creatorSignature";
    import type { character } from "src/ts/storage/database.svelte";

    interface Props {
        char: character;
        className?: string;
    }

    let { char, className = '' }: Props = $props();

    let verification = $state<SignatureVerification|null>(null)
    let runId = 0

    $effect(() => {
        const chain = $state.snapshot(char.creatorSignatures)
        const content = $state.snapshot(pickSignable(char))
        const id = ++runId
        //debounced so typing in the editor doesn't re-verify on every keystroke
        const timer = setTimeout(async () => {
            const result = await verifyChain(chain, content)
            if(id === runId){
                verification = result
            }
        }, 300)
        return () => clearTimeout(timer)
    })

    //a forged entry can carry someone's authorId, so only verified entries count as the viewer's own
    function isMine(signed:SignatureVerification['entries'][number]){
        return signed.valid && signed.entry.authorId === DBState.db.creatorSigningKey?.authorId
    }

    function signedAt(entry:CreatorSignature){
        return new Date(entry.signedAt * 1000).toLocaleString()
    }
</script>

{#if verification && verification.status !== 'none' && verification.entries.length > 0}
    {@const [original, ...modifiers] = verification.entries}
    <div class="flex flex-col gap-1 text-sm mt-2 p-2 rounded-md border border-darkborderc {className}">
        <div class="flex items-center gap-1 font-semibold">
            {#if verification.status === 'verified'}
                <BadgeCheckIcon size={16} />
                <span>{language.creatorSignature.verified}</span>
            {:else if verification.status === 'modified'}
                <PencilLineIcon size={16} />
                <span>{language.creatorSignature.modified}</span>
            {:else}
                <ShieldAlertIcon size={16} class="text-draculared" />
                <span class="text-draculared">{language.creatorSignature.invalid}</span>
            {/if}
        </div>
        <div class="flex flex-wrap items-center gap-x-1">
            <span class="text-textcolor2">{language.creatorSignature.originalAuthor}:</span>
            <span class:text-draculared={!original.valid} use:tooltip={signedAt(original.entry)}>{original.entry.name}</span>
            <span class="font-mono text-xs text-textcolor2">({original.entry.authorId})</span>
            {#if isMine(original)}
                <span class="text-xs px-1 rounded-sm bg-selected">{language.creatorSignature.you}</span>
            {/if}
        </div>
        {#if modifiers.length > 0}
            <div class="flex flex-wrap items-center gap-x-1">
                <span class="text-textcolor2">{language.creatorSignature.modifiedBy}:</span>
                {#each modifiers as modifier, i}
                    {#if i > 0}
                        <span class="text-textcolor2">·</span>
                    {/if}
                    <span class:text-draculared={!modifier.valid} use:tooltip={`${modifier.entry.authorId} · ${signedAt(modifier.entry)}`}>{modifier.entry.name}</span>
                    {#if isMine(modifier)}
                        <span class="text-xs px-1 rounded-sm bg-selected">{language.creatorSignature.you}</span>
                    {/if}
                {/each}
            </div>
        {/if}
    </div>
{/if}
