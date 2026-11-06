import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { get } from "svelte/store"

type AlertQueue = typeof import("./alertQueue")
let q: AlertQueue

const visibleType = () => get(q.alertStore).type
const visibleMsg = () => get(q.alertStore).msg

beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    q = await import("./alertQueue")
})

afterEach(() => {
    vi.useRealTimers()
})

describe("alert queue", () => {
    it("queues a dialog instead of overwriting the one on screen", async () => {
        const confirm = q.openDialog({ type: "ask", msg: "Delete?" })
        void q.openDialog({ type: "error", msg: "Network failed" })
        expect(visibleMsg()).toBe("Delete?")

        q.resolveDialog("yes")
        await expect(confirm).resolves.toBe("yes")
        expect(visibleType()).toBe("none")

        vi.runAllTimers()
        expect(visibleMsg()).toBe("Network failed")
    })

    it("answers only the dialog on screen when it is answered twice in one task", () => {
        void q.openDialog({ type: "ask", msg: "First" })
        const second = vi.fn()
        q.openDialog({ type: "ask", msg: "Second" }).then(second)

        q.resolveDialog("yes")
        q.resolveDialog("yes")
        vi.runAllTimers()

        expect(visibleMsg()).toBe("Second")
        expect(second).not.toHaveBeenCalled()
    })

    it("keeps a status overlay below an open dialog", () => {
        void q.openDialog({ type: "normal", msg: "Saved" })
        q.setStatusAlert({ type: "wait", msg: "Syncing" })
        expect(visibleMsg()).toBe("Saved")

        q.resolveDialog("")
        expect(visibleMsg()).toBe("Syncing")
    })

    it("lets a new dialog replace the status overlay", () => {
        q.setStatusAlert({ type: "wait", msg: "Loading" })
        void q.openDialog({ type: "normal", msg: "Done" })
        expect(visibleMsg()).toBe("Done")

        q.resolveDialog("")
        expect(visibleType()).toBe("none")
    })

    it("routes the legacy store by layer and never closes a dialog from code", async () => {
        q.alertStore.set({ type: "ask", msg: "Continue?" })
        q.alertStore.set({ type: "wait", msg: "Working" })
        q.alertStore.set({ type: "toast", msg: "Hi" })
        q.alertStore.set({ type: "none", msg: "" })
        expect(visibleMsg()).toBe("Continue?")
        expect(get(q.toastStore).map((toast) => toast.msg)).toEqual(["Hi"])

        q.alertDialogStore.set({ type: "none", msg: "no" })
        expect(visibleType()).toBe("none")
    })

    it("reuses identical dialogs and replaces queued notices of the same type", async () => {
        void q.openDialog({ type: "ask", msg: "Busy" })
        const first = q.openDialog({ type: "error", msg: "Error 1" }, { replaceable: true })
        const second = q.openDialog({ type: "error", msg: "Error 2" }, { replaceable: true })
        expect(q.openDialog({ type: "error", msg: "Error 2" }, { replaceable: true })).toBe(second)
        await expect(first).resolves.toBe("")

        q.resolveDialog("yes")
        vi.runAllTimers()
        expect(visibleMsg()).toBe("Error 2")
    })

    it("dismisses the open dialog first, then the status overlay", async () => {
        q.setStatusAlert({ type: "progress", msg: "Exporting", submsg: "40" })
        const confirm = q.openDialog({ type: "ask", msg: "Overwrite?" })
        q.setStatusAlert({ type: "progress", msg: "Exporting", submsg: "50" })

        q.dismissAlert()
        await expect(confirm).resolves.toBe("")
        expect(visibleType()).toBe("progress")

        q.dismissAlert()
        expect(visibleType()).toBe("none")
    })

    it("waits for dialogs queued while waiting", async () => {
        void q.openDialog({ type: "normal", msg: "One" })
        const done = vi.fn()
        q.waitForDialogs().then(done)

        void q.openDialog({ type: "normal", msg: "Two" })
        q.resolveDialog("")
        await vi.runAllTimersAsync()
        expect(done).not.toHaveBeenCalled()

        q.resolveDialog("")
        await vi.runAllTimersAsync()
        expect(done).toHaveBeenCalled()
    })
})
