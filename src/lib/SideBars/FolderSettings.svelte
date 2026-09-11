<script lang="ts">
    import { onMount, untrack } from "svelte";
    import { Folder, Image, X } from "@lucide/svelte";
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import type { folder } from "src/ts/storage/database.svelte";
    import { createFolderDraft } from "src/ts/gui/folderAppearance";
    import { saveAsset } from "src/ts/globalApi.svelte";
    import FolderVisual from "./FolderVisual.svelte";
    import FolderColorPalette from "./FolderColorPalette.svelte";
    import { folderIcons } from "./FolderIcons";

    let { source, onClose }: { source: folder; onClose: () => void } = $props();
    // This component is keyed by folder ID. Never bind form controls to the DB proxy.
    const folderId = untrack(() => source.id);
    const nameLimit = untrack(() => Math.max(20, source.name.length));
    let draft = $state(untrack(() => createFolderDraft(source)));
    let dialog: HTMLDialogElement;
    let imageInput: HTMLInputElement;
    let disposed = false;
    let pendingImage: Uint8Array | undefined;
    let imagePreview = $state("");
    let busy = $state(false);
    let error = $state("");
    const labels = language.folderSettings;

    onMount(() => {
        dialog.showModal();
        return () => {
            disposed = true;
            if (imagePreview) URL.revokeObjectURL(imagePreview);
            dialog.close();
        };
    });

    async function chooseImage(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        busy = true;
        error = "";
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const url = URL.createObjectURL(file);
            try {
                // Reject malformed files before replacing the existing preview.
                const image = new window.Image();
                image.src = url;
                await image.decode();
            } catch (cause) {
                URL.revokeObjectURL(url);
                throw cause;
            }
            if (disposed) {
                URL.revokeObjectURL(url);
                return;
            }
            if (imagePreview) URL.revokeObjectURL(imagePreview);
            imagePreview = url;
            pendingImage = bytes;
            draft.visualMode = "image";
        } catch {
            error = labels.imageError;
        } finally {
            input.value = "";
            busy = false;
        }
    }

    async function save() {
        if (busy || !draft.name.trim()) return;
        busy = true;
        error = "";
        try {
            const changes = { ...draft, name: draft.name.trim() };
            if (pendingImage && draft.visualMode === "image") {
                changes.imgFile = await saveAsset(pendingImage);
                // File URLs are resolved from imgFile, never persist an object URL.
                changes.img = "";
            }
            // Re-resolve after asynchronous asset writes; preserve current children/order.
            const index = DBState.db.characterOrder.findIndex(
                (item) => typeof item !== "string" && item.id === folderId,
            );
            if (index < 0) {
                error = labels.folderMissing;
                return;
            }
            const current = DBState.db.characterOrder[index] as folder;
            DBState.db.characterOrder[index] = { ...current, ...changes };
            onClose();
        } catch {
            error = labels.saveError;
        } finally {
            busy = false;
        }
    }
</script>

<dialog
    bind:this={dialog}
    class="folder-settings bg-bgcolor text-textcolor border border-borderc"
    aria-labelledby="folder-settings-title"
    oncancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
    }}
>
    <form
        onsubmit={(event) => {
            event.preventDefault();
            save();
        }}
    >
        <header>
            <h2 id="folder-settings-title">{labels.title}</h2>
            <button
                type="button"
                class="close"
                aria-label={labels.close}
                disabled={busy}
                onclick={onClose}><X size={26} /></button
            >
        </header>
        <div class="body">
            <section aria-label={labels.preview}>
                <p class="section-label">{labels.preview}</p>
                <div class="preview bg-darkbg border border-borderc">
                    <span class="indicator bg-textcolor2"></span>
                    <FolderVisual
                        folder={draft}
                        rounded={DBState.db.roundIcons}
                        showName={DBState.db.showFolderName}
                        {imagePreview}
                    />
                    <span class="preview-name">{draft.name || labels.unnamed}</span>
                </div>
            </section>
            <label class="name-label" for="folder-name">{language.folderName}</label>
            <div class="name-input border border-borderc bg-darkbg">
                <input
                    id="folder-name"
                    bind:value={draft.name}
                    maxlength={nameLimit}
                    required
                    autocomplete="off"
                />
                <span class="text-textcolor2">{draft.name.length}/{nameLimit}</span>
            </div>
            <input
                bind:this={imageInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label={labels.upload}
                hidden
                onchange={chooseImage}
            />
            <div class="mode-switch" role="group" aria-label={labels.visualMode}>
                <button
                    type="button"
                    class:active={draft.visualMode === "icon"}
                    aria-pressed={draft.visualMode === "icon"}
                    onclick={() => (draft.visualMode = "icon")}
                    ><Folder size={21} />{labels.builtIn}</button
                >
                <button
                    type="button"
                    class:active={draft.visualMode === "image"}
                    aria-pressed={draft.visualMode === "image"}
                    disabled={busy}
                    onclick={() => {
                        if (draft.imgFile || draft.img || imagePreview) draft.visualMode = "image";
                        else imageInput.click();
                    }}><Image size={21} />{labels.upload}</button
                >
            </div>
            <FolderColorPalette bind:value={draft.color} label={labels.background} background />
            {#if draft.visualMode === "icon"}
                <fieldset>
                    <legend>{labels.icon}</legend>
                    <div class="icon-grid">
                        {#each Object.entries(folderIcons) as [key, Icon]}
                            <button
                                type="button"
                                class="icon-option"
                                aria-label={labels.icons[key] ?? key}
                                aria-pressed={draft.icon === key}
                                title={labels.icons[key] ?? key}
                                onclick={() => (draft.icon = key)}
                            >
                                <span
                                    style:color={draft.icon === key
                                        ? draft.iconColor || undefined
                                        : undefined}><Icon size={25} /></span
                                >
                            </button>
                        {/each}
                    </div>
                </fieldset>
                <FolderColorPalette bind:value={draft.iconColor} label={labels.iconColor} />
            {:else}
                <button
                    type="button"
                    class="replace-image"
                    disabled={busy}
                    onclick={() => imageInput.click()}>{labels.replaceImage}</button
                >
            {/if}
            <div class="opacity">
                <label for="folder-opacity"
                    >{draft.visualMode === "image"
                        ? labels.imageOpacity
                        : labels.iconOpacity}</label
                >
                <input
                    id="folder-opacity"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    bind:value={draft.iconOpacity}
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow={draft.iconOpacity}
                    aria-valuetext={`${draft.iconOpacity}%`}
                />
                <output for="folder-opacity" class="bg-darkbutton text-textcolor2"
                    >{draft.iconOpacity}%</output
                >
            </div>
            {#if error}<p role="alert" class="text-draculared">{error}</p>{/if}
        </div>
        <footer class="border-t border-borderc">
            <button type="button" disabled={busy} onclick={onClose}>{language.cancel}</button>
            <button type="submit" class="active" disabled={busy || !draft.name.trim()}
                >{busy ? labels.working : labels.save}</button
            >
        </footer>
    </form>
</dialog>

<style>
    .folder-settings {
        position: fixed;
        inset: 0;
        margin: auto;
        padding: 0;
        width: min(620px, calc(100vw - 24px));
        max-height: calc(100dvh - 24px);
        border-radius: 22px;
        box-shadow: 0 24px 80px #0005;
        overflow: hidden;
        animation: folder-enter 260ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .folder-settings::backdrop {
        background: #0008;
        backdrop-filter: blur(4px);
        animation: backdrop-enter 180ms ease-out;
    }
    form {
        display: flex;
        flex-direction: column;
        max-height: calc(100dvh - 26px);
    }
    header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 18px 24px 8px;
        flex-shrink: 0;
    }
    h2 {
        font-size: 26px;
        font-weight: 700;
    }
    button {
        cursor: pointer;
    }
    button:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .close {
        display: grid;
        place-items: center;
        width: 44px;
        height: 44px;
        color: var(--color-textcolor2);
        border-radius: 9px;
    }
    .body {
        overflow-y: auto;
        min-height: 0;
        padding: 8px 24px 20px;
        display: flex;
        flex-direction: column;
        gap: 18px;
        overscroll-behavior: contain;
    }
    .section-label,
    legend {
        margin-bottom: 8px;
    }
    .preview {
        display: flex;
        align-items: center;
        gap: 20px;
        min-height: 100px;
        padding: 20px 14px;
        border-radius: 13px;
    }
    .indicator {
        width: 5px;
        height: 36px;
        border-radius: 8px;
        flex-shrink: 0;
    }
    .preview-name {
        font-size: 22px;
        font-weight: 600;
        overflow-wrap: anywhere;
        min-width: 0;
    }
    .name-label {
        margin-bottom: -12px;
    }
    .name-input {
        display: flex;
        align-items: center;
        border-radius: 10px;
        padding: 0 12px;
        min-height: 48px;
        gap: 8px;
    }
    .name-input input {
        width: 100%;
        min-width: 0;
        padding: 10px 0;
        background: transparent;
        outline: none;
    }
    .name-input:focus-within {
        outline: 2px solid var(--color-textcolor2);
    }
    .mode-switch {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
    }
    .mode-switch button,
    footer button,
    .replace-image {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        min-height: 46px;
        padding: 8px 12px;
        border-radius: 10px;
        background: var(--color-darkbutton);
    }
    button.active {
        background: #2455f5;
        color: white;
    }
    fieldset {
        min-width: 0;
    }
    .icon-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
        gap: 7px;
        max-height: 154px;
        overflow-y: auto;
        padding: 3px;
        scrollbar-width: thin;
        scrollbar-color: var(--color-textcolor2) transparent;
        overscroll-behavior: contain;
    }
    .icon-option {
        display: grid;
        place-items: center;
        min-width: 44px;
        height: 44px;
        border: 2px solid transparent;
        border-radius: 10px;
    }
    .icon-option[aria-pressed="true"] {
        background: #80808059;
        border-color: var(--color-textcolor);
    }
    .opacity {
        display: flex;
        align-items: center;
        gap: 14px;
    }
    .opacity label {
        flex-shrink: 0;
    }
    .opacity input {
        flex: 1;
        min-width: 40px;
        min-height: 44px;
        accent-color: #4055ff;
    }
    output {
        border-radius: 30px;
        padding: 5px 12px;
        min-width: 64px;
        text-align: center;
    }
    footer {
        display: flex;
        justify-content: flex-end;
        gap: 12px;
        padding: 14px 24px;
        flex-shrink: 0;
    }
    footer button {
        min-width: 112px;
    }
    button:focus-visible,
    input:focus-visible {
        outline: 2px solid var(--color-textcolor2);
        outline-offset: 2px;
    }
    @keyframes folder-enter {
        from {
            opacity: 0;
            transform: translateY(18px) scale(0.96);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }
    @keyframes backdrop-enter {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
    @media (max-width: 480px) {
        header {
            padding: 12px 16px 4px;
        }
        h2 {
            font-size: 23px;
        }
        .body {
            padding: 8px 16px 16px;
            gap: 16px;
        }
        .preview {
            min-height: 92px;
            padding: 16px 12px;
        }
        .mode-switch button {
            font-size: 14px;
            gap: 6px;
        }
        .opacity {
            flex-wrap: wrap;
            gap: 8px;
        }
        .opacity label {
            width: 100%;
        }
        footer {
            padding: 12px 16px;
        }
        footer button {
            flex: 1;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .folder-settings,
        .folder-settings::backdrop {
            animation: none;
        }
    }
</style>
