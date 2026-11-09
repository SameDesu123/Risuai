<script lang="ts">
    import { TriangleAlert, XIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { restartApp } from 'src/ts/emergencyMode';

    let hidden = $state(false)
</script>

{#if !hidden}
    <div class="fixed top-2 left-1/2 -translate-x-1/2 z-1000 max-w-[calc(100%-1rem)] w-max flex items-center gap-2 px-3 py-2 rounded-md border border-red-600 bg-darkbg text-textcolor text-sm shadow-lg" role="status">
        <TriangleAlert size={16} class="text-red-500 shrink-0" />
        <div class="flex flex-col min-w-0">
            <span class="font-bold">{language.emergencyMode.title}</span>
            <span class="text-textcolor2 text-xs">{language.emergencyMode.banner}</span>
        </div>
        <button class="shrink-0 px-2 py-1 rounded-md border border-darkborderc hover:bg-selected transition-colors" onclick={() => {
            restartApp(false)
        }}>
            {language.emergencyMode.exit}
        </button>
        <button class="shrink-0 text-textcolor2 hover:text-textcolor" aria-label="Hide" onclick={() => {
            hidden = true
        }}>
            <XIcon size={16} />
        </button>
    </div>
{/if}
