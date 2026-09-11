<script lang="ts">
    import { language } from "src/lang";
    import { folderLongPress } from "src/ts/gui/folderLongPress";
    import type { FolderAppearance } from "src/ts/gui/folderAppearance";
    import FolderVisual from "./FolderVisual.svelte";

    let {
        folder,
        rounded,
        open,
        showName,
        onToggle,
        onSettings,
    }: {
        folder: FolderAppearance;
        rounded: boolean;
        open: boolean;
        showName: boolean;
        onToggle: () => void;
        onSettings: () => void;
    } = $props();
</script>

<button
    type="button"
    class="folder-button"
    aria-label={folder.name}
    aria-expanded={open}
    title={`${folder.name} — ${language.folderSettings.title}`}
    use:folderLongPress={onSettings}
    onclick={onToggle}
    oncontextmenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSettings();
    }}
    onkeydown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            onSettings();
        }
    }}
>
    <FolderVisual {folder} {rounded} {open} {showName} />
</button>

<style>
    .folder-button {
        position: relative;
        display: block;
        border-radius: 10px;
        touch-action: pan-y;
        user-select: none;
        -webkit-touch-callout: none;
    }
    .folder-button:focus-visible {
        outline: 2px solid var(--color-textcolor);
        outline-offset: 3px;
    }
    .folder-button::after {
        content: "";
        position: absolute;
        inset: -3px;
        border: 2px solid transparent;
        border-radius: 13px;
        pointer-events: none;
    }
    .folder-button:global(.folder-pressing) {
        animation: folder-press 500ms ease-out both;
    }
    .folder-button:global(.folder-pressing)::after {
        border-color: var(--color-textcolor);
        animation: folder-outline 380ms 120ms linear both;
    }
    :global(.folder-press-dimmer) {
        position: fixed;
        inset: 0;
        z-index: 100;
        pointer-events: none;
        background: #000;
        animation: folder-dim 380ms 120ms both;
    }
    @keyframes folder-press {
        to {
            transform: scale(0.94);
        }
    }
    @keyframes folder-outline {
        from {
            clip-path: inset(0 100% 0 0);
            opacity: 0.3;
        }
        to {
            clip-path: inset(0);
            opacity: 1;
        }
    }
    @keyframes folder-dim {
        from {
            opacity: 0;
        }
        to {
            opacity: 0.12;
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .folder-button:global(.folder-pressing) {
            animation: none;
        }
        .folder-button:global(.folder-pressing)::after {
            animation: none;
        }
        :global(.folder-press-dimmer) {
            animation: none;
            opacity: 0.08;
        }
    }
</style>
