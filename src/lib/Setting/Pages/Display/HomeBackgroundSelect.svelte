<script lang="ts">
    import { language } from 'src/lang';
    import { getCharImage } from 'src/ts/characters';
    import {
        getHomeBackgroundStyle,
        homeBackgroundPresetList,
        normalizeHomeScreenSettings,
    } from 'src/ts/gui/homeScreen';
    import { saveImage } from 'src/ts/storage/database.svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import { selectSingleFile } from 'src/ts/util';
    import { ImageIcon, BanIcon } from '@lucide/svelte';

    let home = $derived(normalizeHomeScreenSettings(DBState.db.homeScreen));
    let imageUrl = $state('');
    let picking = $state(false);

    $effect(() => {
        const image = home.image;
        if (!image) {
            imageUrl = '';
            return;
        }
        getCharImage(image, 'plain').then((url) => {
            if (home.image === image) {
                imageUrl = url ?? '';
            }
        });
    });

    const formatName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

    function setBackground(background: string) {
        DBState.db.homeScreen = { ...home, background };
    }

    async function pickImage() {
        if (picking) {
            return;
        }
        picking = true;
        try {
            const file = await selectSingleFile(['png', 'webp', 'gif', 'jpg', 'jpeg']);
            if (!file) {
                return;
            }
            const image = await saveImage(file.data);
            DBState.db.homeScreen = { ...home, background: 'image', image };
        } finally {
            picking = false;
        }
    }

    function previewStyle(background: string) {
        return getHomeBackgroundStyle({ ...home, background }, imageUrl);
    }
</script>

<span class="text-textcolor mt-4">{language.homeBackground}</span>

<div class="mt-2 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
    <button
        type="button"
        class="flex flex-col items-stretch gap-2 rounded-md border p-2 text-center transition-colors hover:bg-darkbutton focus:outline-hidden focus:ring-2 focus:ring-borderc"
        class:border-borderc={home.background === ''}
        class:border-darkborderc={home.background !== ''}
        class:bg-darkbutton={home.background === ''}
        aria-pressed={home.background === ''}
        onclick={() => setBackground('')}
    >
        <span class="flex h-16 items-center justify-center rounded-sm bg-bgcolor text-textcolor2" aria-hidden="true">
            <BanIcon size={20} />
        </span>
        <span class="w-full truncate text-sm text-textcolor">{language.homeBackgroundNone}</span>
    </button>

    {#each homeBackgroundPresetList as preset}
        <button
            type="button"
            class="flex flex-col items-stretch gap-2 rounded-md border p-2 text-center transition-colors hover:bg-darkbutton focus:outline-hidden focus:ring-2 focus:ring-borderc"
            class:border-borderc={home.background === preset}
            class:border-darkborderc={home.background !== preset}
            class:bg-darkbutton={home.background === preset}
            aria-pressed={home.background === preset}
            onclick={() => setBackground(preset)}
        >
            <span class="block h-16 rounded-sm" style={previewStyle(preset)} aria-hidden="true"></span>
            <span class="w-full truncate text-sm text-textcolor">{formatName(preset)}</span>
        </button>
    {/each}

    <button
        type="button"
        class="flex flex-col items-stretch gap-2 rounded-md border p-2 text-center transition-colors hover:bg-darkbutton focus:outline-hidden focus:ring-2 focus:ring-borderc"
        class:border-borderc={home.background === 'image'}
        class:border-darkborderc={home.background !== 'image'}
        class:bg-darkbutton={home.background === 'image'}
        aria-pressed={home.background === 'image'}
        disabled={picking}
        onclick={() => {
            if (home.image && home.background !== 'image') {
                setBackground('image');
                return;
            }
            pickImage();
        }}
    >
        {#if imageUrl}
            <span class="block h-16 rounded-sm" style={previewStyle('image')} aria-hidden="true"></span>
        {:else}
            <span class="flex h-16 items-center justify-center rounded-sm bg-bgcolor text-textcolor2" aria-hidden="true">
                <ImageIcon size={20} />
            </span>
        {/if}
        <span class="w-full truncate text-sm text-textcolor">{language.homeBackgroundImage}</span>
    </button>
</div>

{#if home.background === 'image'}
    <button
        type="button"
        class="mt-2 self-start rounded-md border border-darkborderc px-3 py-1 text-sm text-textcolor transition-colors hover:bg-darkbutton"
        disabled={picking}
        onclick={pickImage}
    >
        {language.homeChangeImage}
    </button>
{/if}
