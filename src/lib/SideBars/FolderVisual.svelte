<script lang="ts">
    import { FolderOpen } from "@lucide/svelte";
    import { getCharImage } from "src/ts/characters";
    import {
        folderBackground,
        folderOpacity,
        folderUsesImage,
        type FolderAppearance,
    } from "src/ts/gui/folderAppearance";
    import { getFolderIcon } from "./FolderIcons";

    let {
        folder,
        rounded = false,
        open = false,
        showName = false,
        imagePreview = "",
    }: {
        folder: FolderAppearance;
        rounded?: boolean;
        open?: boolean;
        showName?: boolean;
        imagePreview?: string;
    } = $props();
    let Icon = $derived(
        open && (!folder.icon || folder.icon === "folder")
            ? FolderOpen
            : getFolderIcon(folder.icon),
    );
    let imageSource = $derived(
        imagePreview || (folder.imgFile ? getCharImage(folder.imgFile, "plain") : folder.img || ""),
    );
</script>

<div
    class="folder-visual avatar border border-selected bg-darkbg text-textcolor"
    class:rounded
    style:background-color={folderBackground(folder.color)}
>
    {#if folderUsesImage(folder) || (folder.visualMode === "image" && imagePreview)}
        {#await imageSource then src}
            {#if src}<img
                    {src}
                    alt=""
                    draggable="false"
                    style:opacity={folderOpacity(folder) / 100}
                />{/if}
        {/await}
    {:else}
        <span
            class="content"
            style:color={folder.iconColor || undefined}
            style:opacity={folderOpacity(folder) / 100}
        >
            {#if showName}<span class="truncate font-bold">{folder.name}</span>{:else}<Icon
                    size={26}
                />{/if}
        </span>
    {/if}
</div>

<style>
    .folder-visual {
        width: 56px;
        height: 56px;
        flex-shrink: 0;
        border-radius: 10px;
        overflow: hidden;
    }
    .rounded {
        border-radius: 50%;
    }
    .content {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        padding: 4px;
    }
    img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
</style>
