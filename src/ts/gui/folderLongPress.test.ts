import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { folderLongPress } from "./folderLongPress";

let button: HTMLButtonElement;
let action: ReturnType<typeof folderLongPress>;
let open = vi.fn<() => void>();
function pointer(type: string, options: PointerEventInit = {}) {
    button.dispatchEvent(
        new PointerEvent(type, {
            bubbles: true,
            pointerType: "touch",
            pointerId: 1,
            isPrimary: true,
            clientX: 10,
            clientY: 10,
            ...options,
        }),
    );
}
beforeEach(() => {
    vi.useFakeTimers();
    button = document.createElement("button");
    button.setPointerCapture = vi.fn();
    document.body.append(button);
    open = vi.fn();
    action = folderLongPress(button, open);
});
afterEach(() => {
    action.destroy();
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe("folder touch gesture", () => {
    it("opens once at 500ms and consumes the release click even over the modal", () => {
        const accidentalClick = vi.fn();
        const modalButton = document.createElement("button");
        modalButton.addEventListener("click", accidentalClick);
        document.body.append(modalButton);
        pointer("pointerdown");
        expect(button.classList.contains("folder-pressing")).toBe(true);
        vi.advanceTimersByTime(499);
        expect(open).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);
        expect(document.querySelector(".folder-press-dimmer")).toBeNull();
        pointer("pointerup");
        modalButton.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
        expect(accidentalClick).not.toHaveBeenCalled();
        modalButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        modalButton.click();
        expect(accidentalClick).toHaveBeenCalledTimes(1);
    });

    it.each(["pointerup", "pointercancel", "dragstart"])(
        "cancels on %s without opening",
        (event) => {
            pointer("pointerdown");
            vi.advanceTimersByTime(200);
            const target = event === "dragstart" ? button.parentElement! : button;
            target.dispatchEvent(new Event(event, { bubbles: true }));
            vi.advanceTimersByTime(500);
            expect(open).not.toHaveBeenCalled();
            expect(document.querySelector(".folder-press-dimmer")).toBeNull();
        },
    );

    it("cancels for scrolling movement and a second finger", () => {
        pointer("pointerdown");
        pointer("pointermove", { clientY: 21 });
        vi.advanceTimersByTime(600);
        expect(open).not.toHaveBeenCalled();
        pointer("pointerdown");
        pointer("pointerdown", { pointerId: 2, isPrimary: false });
        vi.advanceTimersByTime(600);
        expect(open).not.toHaveBeenCalled();
    });

    it("does not turn mouse or pen holds into settings", () => {
        for (const pointerType of ["mouse", "pen"]) {
            pointer("pointerdown", { pointerType });
            vi.advanceTimersByTime(600);
        }
        expect(open).not.toHaveBeenCalled();
        expect(button.classList.contains("folder-pressing")).toBe(false);
    });

    it("blocks the native touch context menu without opening early", () => {
        const contextMenu = vi.fn();
        button.addEventListener("contextmenu", contextMenu);
        pointer("pointerdown");
        button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        expect(contextMenu).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        pointer("pointerup");
        pointer("pointerdown", { pointerType: "mouse" });
        button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        expect(contextMenu).toHaveBeenCalledOnce();
    });

    it("removes pending timers and feedback when unmounted", () => {
        pointer("pointerdown");
        action.destroy();
        vi.advanceTimersByTime(600);
        expect(open).not.toHaveBeenCalled();
        expect(document.querySelector(".folder-press-dimmer")).toBeNull();
    });
    it("reserves small touch movements for holding and releases larger moves to drag", () => {
        const dragPolyfill = vi.fn();
        document.addEventListener("touchmove", dragPolyfill);
        try {
            pointer("pointerdown");
            pointer("pointermove", { clientX: 12 });
            button.dispatchEvent(new Event("touchmove", { bubbles: true }));
            expect(dragPolyfill).not.toHaveBeenCalled();
            pointer("pointermove", { clientX: 25 });
            button.dispatchEvent(new Event("touchmove", { bubbles: true }));
            expect(dragPolyfill).toHaveBeenCalledOnce();
            vi.advanceTimersByTime(600);
            expect(open).not.toHaveBeenCalled();
        } finally {
            document.removeEventListener("touchmove", dragPolyfill);
        }
    });
});
