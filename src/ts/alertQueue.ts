import { writable } from "svelte/store"
import type { alertData } from "./alert"

// Alerts live in three layers so that they no longer overwrite each other:
// - dialogs: alerts the user answers or dismisses, shown one at a time in FIFO order
// - status: non-interactive 'wait' / 'wait2' / 'progress' overlays, the latest one wins
// - toasts: short messages that never block anything
// `alertStore` holds the single alert that should be on screen right now.

type PendingDialog = {
    data: alertData
    promise: Promise<string>
    resolve: (msg: string) => void
    replaceable: boolean
}

const statusTypes: alertData['type'][] = ['wait', 'wait2', 'progress']
const emptyAlert: alertData = { type: 'none', msg: '' }

let currentDialog: PendingDialog | null = null
const dialogQueue: PendingDialog[] = []
let showNextTimer: ReturnType<typeof setTimeout> | null = null
let statusAlert: alertData | null = null
let visible: alertData = emptyAlert
const visibleAlert = writable<alertData>(emptyAlert)

function render() {
    const next = currentDialog?.data ?? statusAlert ?? emptyAlert
    if (next !== visible) {
        visible = next
        visibleAlert.set(next)
    }
}

function showNextDialog() {
    showNextTimer = null
    currentDialog = dialogQueue.shift() ?? null
    render()
}

function isSameAlert(a: alertData, b: alertData) {
    return a.type === b.type && a.msg === b.msg && a.submsg === b.submsg
}

/**
 * Queues a dialog and resolves with the user's answer.
 * An identical dialog that is already open or queued is reused instead of being shown twice.
 * A `replaceable` dialog takes the place of a replaceable dialog of the same type
 * that is still waiting in line, so notices nobody awaits do not pile up.
 */
export function openDialog(data: alertData, options: { replaceable?: boolean } = {}): Promise<string> {
    const same = [currentDialog, ...dialogQueue].find((pending) => pending && isSameAlert(pending.data, data))
    if (same) {
        return same.promise
    }

    // As before, a new dialog replaces whatever status overlay was shown.
    statusAlert = null

    let resolve: (msg: string) => void
    const promise = new Promise<string>((r) => {
        resolve = r
    })
    const entry: PendingDialog = { data, promise, resolve, replaceable: options.replaceable ?? false }

    const replaceIndex = entry.replaceable
        ? dialogQueue.findIndex((pending) => pending.replaceable && pending.data.type === data.type)
        : -1
    if (replaceIndex !== -1) {
        const [replaced] = dialogQueue.splice(replaceIndex, 1, entry)
        replaced.resolve('')
    } else {
        dialogQueue.push(entry)
    }

    if (!currentDialog && !showNextTimer) {
        showNextDialog()
    } else {
        render()
    }
    return promise
}

/** Answers the dialog on screen with `msg`. Does nothing when no dialog is on screen. */
export function resolveDialog(msg: string) {
    const answered = currentDialog
    if (!answered) {
        return
    }
    currentDialog = null
    render()
    if (dialogQueue.length > 0 && !showNextTimer) {
        // Show the next dialog in a new task, so the input that answered this one
        // (e.g. Enter on a focused button firing both keydown and click) cannot answer it too.
        showNextTimer = setTimeout(showNextDialog, 0)
    }
    answered.resolve(msg)
}

/** Closes what is on screen: cancels the open dialog, or hides the status overlay. */
export function dismissAlert() {
    if (currentDialog) {
        resolveDialog('')
    } else {
        setStatusAlert(null)
    }
}

/** Shows a status overlay below any open dialog, or hides it with `null`. */
export function setStatusAlert(data: alertData | null) {
    statusAlert = data
    render()
}

/** Resolves once every dialog, including ones queued while waiting, is closed. */
export async function waitForDialogs() {
    let last: PendingDialog | null
    while ((last = dialogQueue[dialogQueue.length - 1] ?? currentDialog)) {
        await last.promise
    }
}

export const toastStore = writable<{ id: number, msg: string }[]>([])
let toastId = 0

export function pushToast(msg: string) {
    const id = ++toastId
    toastStore.update((toasts) => [...toasts, { id, msg }])
}

export function removeToast(id: number) {
    toastStore.update((toasts) => toasts.filter((toast) => toast.id !== id))
}

function routeAlert(data: alertData) {
    if (data.type === 'toast') {
        pushToast(data.msg)
    } else if (data.type === 'none') {
        setStatusAlert(null)
    } else if (statusTypes.includes(data.type)) {
        setStatusAlert(data)
    } else {
        void openDialog(data)
    }
}

/**
 * Drop-in replacement for the old single-slot store.
 * Reading gives the alert on screen; `set` sends the alert to its layer.
 * Setting `type: 'none'` here only hides the status overlay and never closes a dialog.
 */
export const alertStore = {
    subscribe: visibleAlert.subscribe,
    set: routeAlert,
}

/** Store for AlertComp: setting `type: 'none'` answers the dialog on screen with `msg`. */
export const alertDialogStore = {
    subscribe: visibleAlert.subscribe,
    set(data: alertData) {
        if (data.type === 'none') {
            resolveDialog(data.msg)
        } else {
            routeAlert(data)
        }
    },
}
