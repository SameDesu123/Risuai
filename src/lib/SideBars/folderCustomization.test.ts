import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { folder } from "src/ts/storage/database.svelte";
import {
    createFolderDraft,
    folderBackground,
    folderOpacity,
    folderUsesImage,
} from "src/ts/gui/folderAppearance";
import FolderSettings from "./FolderSettings.svelte";
import FolderButton from "./FolderButton.svelte";

const mocks = vi.hoisted(() => ({
    DBState: {
        db: { characterOrder: [] as (string | folder)[], roundIcons: false, showFolderName: false },
    },
    saveAsset: vi.fn(),
}));
vi.mock("src/ts/stores.svelte", () => ({ DBState: mocks.DBState }));
vi.mock("src/ts/globalApi.svelte", () => ({ saveAsset: mocks.saveAsset }));
vi.mock("src/ts/characters", () => ({ getCharImage: (path: string) => path }));

let mounted: ReturnType<typeof mount>[] = [];
let source: folder;
let close = vi.fn<() => void>();
function element<T extends HTMLElement = HTMLButtonElement>(selector: string): T {
    const node = document.querySelector<T>(selector);
    expect(node, selector).not.toBeNull();
    return node!;
}
async function renderSettings() {
    mounted.push(
        mount(FolderSettings, { target: document.body, props: { source, onClose: close } }),
    );
    await tick();
}
async function input(selector: string, value: string) {
    const node = element<HTMLInputElement>(selector);
    node.value = value;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
}
async function save() {
    element<HTMLFormElement>("form").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();
}
beforeEach(() => {
    source = { id: "folder-a", name: "Original", color: "blue", data: ["character-a"] };
    mocks.DBState.db.characterOrder = [source];
    close = vi.fn();
    mocks.saveAsset.mockReset().mockResolvedValue("assets/uploaded.png");
});
afterEach(async () => {
    for (const component of mounted) await unmount(component);
    mounted = [];
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

describe("folder customization", () => {
    it("keeps legacy images/colors and explicit zero opacity compatible", () => {
        expect(folderBackground("blue")).toBe("#1d4ed880");
        expect(folderBackground("#123456")).toBe("#123456");
        expect(folderOpacity({ ...source, iconOpacity: 0 })).toBe(0);
        expect(folderOpacity(source)).toBe(100);
        expect(folderUsesImage({ ...source, imgFile: "old.png" })).toBe(true);
        expect(createFolderDraft({ ...source, imgFile: "old.png" }).visualMode).toBe("image");
    });

    it("opens on mouse contextmenu immediately, while ordinary clicks still toggle", async () => {
        const onSettings = vi.fn();
        const onToggle = vi.fn();
        mounted.push(
            mount(FolderButton, {
                target: document.body,
                props: {
                    folder: source,
                    rounded: false,
                    open: false,
                    showName: false,
                    onSettings,
                    onToggle,
                },
            }),
        );
        await tick();
        const button = element("button");
        button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        expect(onSettings).toHaveBeenCalledOnce();
        expect(onToggle).not.toHaveBeenCalled();
        expect(document.querySelector(".folder-press-dimmer")).toBeNull();
        button.click();
        expect(onToggle).toHaveBeenCalledOnce();
        button.dispatchEvent(
            new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
        );
        expect(onSettings).toHaveBeenCalledTimes(2);
    });

    it("previews edits without touching source and cancels cleanly", async () => {
        await renderSettings();
        await input("#folder-name", "Draft name");
        element('[aria-label="Heart"]').click();
        await tick();
        expect(element(".preview-name").textContent).toBe("Draft name");
        expect(element('[aria-label="Heart"]').getAttribute("aria-pressed")).toBe("true");
        expect(source.name).toBe("Original");
        expect(source.icon).toBeUndefined();
        element('footer button[type="button"]').click();
        expect(close).toHaveBeenCalledOnce();
        expect(mocks.DBState.db.characterOrder[0]).toEqual(source);
        expect(mocks.saveAsset).not.toHaveBeenCalled();
    });

    it("saves by ID after reorder, preserving current children and unrelated fields", async () => {
        await renderSettings();
        await input("#folder-name", "Saved");
        await input("#folder-opacity", "0");
        const current = { ...source, data: ["character-a", "new-child"], futureField: "preserved" };
        mocks.DBState.db.characterOrder = ["another-character", current];
        await save();
        expect(mocks.DBState.db.characterOrder[0]).toBe("another-character");
        expect(mocks.DBState.db.characterOrder[1]).toMatchObject({
            name: "Saved",
            iconOpacity: 0,
            data: ["character-a", "new-child"],
            futureField: "preserved",
        });
        expect(close).toHaveBeenCalledOnce();
    });

    it("keeps an existing long name intact and rejects blank names", async () => {
        source.name = "A legacy name that exceeds twenty characters";
        await renderSettings();
        expect(element<HTMLInputElement>("#folder-name").value).toBe(source.name);
        await input("#folder-name", "   ");
        expect(element<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
        await save();
        expect(close).not.toHaveBeenCalled();
        expect(source.name).toBe("A legacy name that exceeds twenty characters");
    });

    it("reports a deleted folder instead of updating the wrong entry", async () => {
        await renderSettings();
        mocks.DBState.db.characterOrder = ["another-character"];
        await save();
        expect(element('[role="alert"]').textContent).toContain("no longer exists");
        expect(mocks.DBState.db.characterOrder).toEqual(["another-character"]);
        expect(close).not.toHaveBeenCalled();
    });

    it("hides icon controls for legacy image folders and keeps the image on mode switches", async () => {
        source.imgFile = "legacy.png";
        await renderSettings();
        expect(document.querySelector(".icon-grid")).toBeNull();
        expect(element(".opacity label").textContent).toBe("Image opacity");
        element(".mode-switch button:first-child").click();
        await tick();
        expect(document.querySelector(".icon-grid")).not.toBeNull();
        await save();
        expect(mocks.DBState.db.characterOrder[0]).toMatchObject({
            visualMode: "icon",
            imgFile: "legacy.png",
        });
    });
    async function uploadImage() {
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview-only");
        vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
        vi.spyOn(window.Image.prototype, "decode").mockResolvedValue(undefined);
        const file = new File([new Uint8Array([1, 2, 3])], "test.png", { type: "image/png" });
        const picker = element<HTMLInputElement>('input[type="file"]');
        Object.defineProperty(picker, "files", { value: [file] });
        picker.dispatchEvent(new Event("change", { bubbles: true }));
        await vi.waitFor(() => expect(document.querySelector(".replace-image")).not.toBeNull());
        await tick();
    }

    it("keeps uploads temporary until save and never persists the preview URL", async () => {
        await renderSettings();
        await uploadImage();
        expect(mocks.saveAsset).not.toHaveBeenCalled();
        expect(source.imgFile).toBeUndefined();
        expect(element<HTMLImageElement>(".preview img").src).toBe("blob:preview-only");
        await save();
        expect(mocks.saveAsset).toHaveBeenCalledOnce();
        expect(mocks.DBState.db.characterOrder[0]).toMatchObject({
            imgFile: "assets/uploaded.png",
            img: "",
            visualMode: "image",
        });
        expect(close).toHaveBeenCalledOnce();
    });

    it("leaves the original folder intact when writing the image fails", async () => {
        await renderSettings();
        await uploadImage();
        mocks.saveAsset.mockRejectedValueOnce(new Error("Storage full"));
        await save();
        expect(element('[role="alert"]').textContent).toContain("Could not save");
        expect(mocks.DBState.db.characterOrder[0]).toEqual(source);
        expect(close).not.toHaveBeenCalled();
        expect(element<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
    });

    it("re-resolves the folder after an asynchronous image write", async () => {
        await renderSettings();
        await uploadImage();
        let finish: (path: string) => void;
        mocks.saveAsset.mockImplementationOnce(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                }),
        );
        await save();
        const otherFolder = { ...source, id: "other", name: "Other" };
        mocks.DBState.db.characterOrder = [otherFolder, { ...source, data: ["new-child"] }];
        finish!("assets/delayed.png");
        await tick();
        expect(mocks.DBState.db.characterOrder[0]).toEqual(otherFolder);
        expect(mocks.DBState.db.characterOrder[1]).toMatchObject({
            imgFile: "assets/delayed.png",
            data: ["new-child"],
        });
        expect(close).toHaveBeenCalledOnce();
    });
});
