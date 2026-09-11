// Touch-only action: mouse users open settings through the context-menu handler.
export function folderLongPress(node: HTMLButtonElement, open: () => void) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pointer: { id: number; x: number; y: number } | undefined;
    let consumeClick = false;
    let touchGesture = false;
    let dimmer: HTMLDivElement | undefined;

    function cancel() {
        clearTimeout(timer);
        timer = undefined;
        pointer = undefined;
        node.classList.remove("folder-pressing");
        dimmer?.remove();
        dimmer = undefined;
    }

    function resetGesture(event: PointerEvent) {
        consumeClick = false;
        if (pointer && event.pointerId !== pointer.id) cancel();
    }

    function down(event: PointerEvent) {
        touchGesture = event.pointerType === "touch";
        if (event.pointerType !== "touch" || !event.isPrimary) {
            cancel();
            return;
        }
        cancel();
        consumeClick = false;
        pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
        node.classList.add("folder-pressing");
        dimmer = document.createElement("div");
        dimmer.className = "folder-press-dimmer";
        dimmer.setAttribute("aria-hidden", "true");
        document.body.append(dimmer);
        timer = setTimeout(() => {
            consumeClick = true;
            cancel();
            navigator.vibrate?.(12);
            open();
        }, 500);
    }

    function move(event: PointerEvent) {
        if (
            pointer?.id === event.pointerId &&
            Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 10
        )
            cancel();
    }

    function touchMove(event: TouchEvent) {
        // The mobile drag polyfill starts on the first touchmove, even for tiny jitter.
        // Keep that gesture local while a hold is pending; movement beyond 10px
        // cancels via pointermove and then falls through to the existing drag behavior.
        if (pointer || consumeClick) event.stopPropagation();
        if (consumeClick) event.preventDefault();
    }

    function click(event: MouseEvent) {
        if (!consumeClick || event.detail === 0) return;
        consumeClick = false;
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function contextMenu(event: MouseEvent) {
        if (!touchGesture) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    // Keep the release on the original button, even after the dialog opens.
    function capture(event: PointerEvent) {
        if (event.pointerType === "touch" && event.isPrimary)
            node.setPointerCapture(event.pointerId);
    }

    node.addEventListener("touchmove", touchMove, { passive: false });
    node.addEventListener("pointerdown", down);
    node.addEventListener("pointerdown", capture);
    window.addEventListener("click", click, true);
    window.addEventListener("pointerdown", resetGesture, true);
    node.addEventListener("contextmenu", contextMenu, true);
    window.addEventListener("dragstart", cancel, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", cancel, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("scroll", cancel, true);
    return {
        update(nextOpen: () => void) {
            open = nextOpen;
        },
        destroy() {
            cancel();
            node.removeEventListener("touchmove", touchMove);
            node.removeEventListener("pointerdown", down);
            node.removeEventListener("pointerdown", capture);
            window.removeEventListener("click", click, true);
            window.removeEventListener("pointerdown", resetGesture, true);
            node.removeEventListener("contextmenu", contextMenu, true);
            window.removeEventListener("dragstart", cancel, true);
            window.removeEventListener("pointermove", move, true);
            window.removeEventListener("pointerup", cancel, true);
            window.removeEventListener("pointercancel", cancel, true);
            window.removeEventListener("blur", cancel);
            window.removeEventListener("scroll", cancel, true);
        },
    };
}
