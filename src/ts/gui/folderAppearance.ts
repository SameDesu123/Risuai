import type { folder } from "../storage/database.svelte";

export type FolderAppearance = Pick<
    folder,
    "name" | "color" | "icon" | "iconColor" | "iconOpacity" | "visualMode" | "imgFile" | "img"
>;

// Preserve the translucent colors used by folders saved before customization.
const legacyColors: Record<string, string> = {
    red: "#b91c1c80",
    yellow: "#a1620780",
    green: "#15803d80",
    blue: "#1d4ed880",
    indigo: "#4338ca80",
    purple: "#7e22ce80",
    pink: "#be185d80",
};

export function folderBackground(color: string): string {
    if (/^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) return color;
    return legacyColors[color] ?? "color-mix(in srgb, var(--color-darkbg) 50%, transparent)";
}

export function folderUsesImage(folder: FolderAppearance): boolean {
    return folder.visualMode !== "icon" && Boolean(folder.imgFile || folder.img);
}

export function folderOpacity(folder: FolderAppearance): number {
    return Number.isFinite(folder.iconOpacity)
        ? Math.max(0, Math.min(100, folder.iconOpacity))
        : 100;
}

export function createFolderDraft(folder: FolderAppearance): FolderAppearance {
    return {
        name: folder.name,
        color: folder.color,
        icon: folder.icon ?? "folder",
        iconColor: folder.iconColor ?? "",
        iconOpacity: folderOpacity(folder),
        visualMode: folderUsesImage(folder) ? "image" : "icon",
        imgFile: folder.imgFile,
        img: folder.img,
    };
}
