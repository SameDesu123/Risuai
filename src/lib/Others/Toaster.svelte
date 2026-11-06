<script lang="ts">
    import { removeToast, toastStore } from "src/ts/alertQueue";
</script>

{#if $toastStore.length > 0}
    <div class="absolute right-0 bottom-0 z-1200 flex flex-col items-end gap-2 max-w-3xl max-h-11/12 overflow-y-auto pointer-events-none">
        {#each $toastStore as toast (toast.id)}
            <div class="toast-anime bg-darkbg p-4 break-any rounded-md text-textcolor" onanimationend={() => removeToast(toast.id)}>
                {toast.msg}
            </div>
        {/each}
    </div>
{/if}

<style>
    @keyframes toastAnime {
        0% {
            opacity: 0;
        }
        50% {
            opacity: 1;
        }
        100% {
            opacity: 0;
        }
    }

    .toast-anime {
        animation: toastAnime 1s ease-out;
    }

    .break-any {
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>
