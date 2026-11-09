/**
 * Emergency mode: a stripped-down start for when Risuai keeps crashing (for example running
 * out of memory) while starting or right after.
 *
 * In emergency mode:
 * - plugins are not loaded (loadPlugins does nothing)
 * - custom CSS is not applied
 * - character / module background HTML is not rendered
 * - a chat opens with only its last few messages rendered
 * - startup skips asset cleanup and character import from the URL
 *
 * The save itself is loaded and saved as usual, so changes made in emergency mode
 * (turning off a plugin, deleting a heavy chat, ...) are kept.
 *
 * Entered with `?emergency` / `?safemode` in the URL, with the restart button in
 * Settings > Advanced, or by accepting the prompt shown after repeated crashes at startup.
 */
import { get, writable } from "svelte/store"
import { changeLanguage, language } from "src/lang"
import { alertSelect, alertWait } from "./alert"
import { SafeModeStore } from "./stores.svelte"
import { sleep } from "./util"
import {
    BOOT_STABLE_AFTER_MS,
    BootGuard,
    EMERGENCY_CRASH_THRESHOLD,
    clearEmergencyNextBoot,
    consumeEmergencyNextBoot,
    hasEmergencyUrlParam,
    requestEmergencyNextBoot,
    urlWithoutEmergencyParams,
    type StorageLike,
} from "./emergencyBootGuard"

export type EmergencyModeReason = 'url' | 'manual' | 'crash'

/** null while emergency mode is off */
export const EmergencyModeStore = writable<{ reason: EmergencyModeReason } | null>(null)

export function isEmergencyMode(): boolean {
    return get(EmergencyModeStore) !== null
}

function getLocalStorage(): StorageLike | null {
    try {
        return globalThis.localStorage ?? null
    } catch {
        return null
    }
}

const bootGuard = new BootGuard(getLocalStorage())
let bootResolved = false

/** The save (and its language setting) is not loaded yet when asking at startup. */
function useBrowserLanguage() {
    try {
        const browserLang = (navigator.language ?? '').toLowerCase()
        const short = browserLang.split('-')[0]
        if (short === 'zh') {
            const traditional = ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].some((v) => browserLang.startsWith(v))
            changeLanguage(traditional ? 'zh-Hant' : 'cn')
        }
        else if (['ko', 'de', 'es', 'vi'].includes(short)) {
            changeLanguage(short)
        }
    } catch {}
}

function watchPageLifecycle() {
    //leaving or hiding the page normally is not a crash
    window.addEventListener('pagehide', () => bootGuard.suspend())
    window.addEventListener('pageshow', (e) => {
        if (e.persisted) {
            bootGuard.resume()
        }
    })
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            bootGuard.suspend()
        }
        else {
            bootGuard.resume()
        }
    })
}

/**
 * Runs at the very start of loading, before the save is read.
 * Records this boot for crash detection and decides whether it runs in emergency mode,
 * asking the user when the previous starts kept crashing.
 */
export async function resolveEmergencyBoot(): Promise<void> {
    if (bootResolved) {
        return
    }
    bootResolved = true

    const crashes = bootGuard.begin()
    watchPageLifecycle()

    let reason: EmergencyModeReason | null = null
    if (hasEmergencyUrlParam(location.search)) {
        reason = 'url'
        //the URL already asks for it; don't carry a pending restart request into a later normal boot
        clearEmergencyNextBoot(getLocalStorage())
    }
    else if (consumeEmergencyNextBoot(getLocalStorage())) {
        reason = 'manual'
    }
    else if (crashes >= EMERGENCY_CRASH_THRESHOLD) {
        useBrowserLanguage()
        const selected = await alertSelect([
            language.emergencyMode.startEmergency,
            language.emergencyMode.startNormally,
        ], language.emergencyMode.crashDetected(crashes))
        if (selected === '0') {
            reason = 'crash'
        }
    }

    if (reason) {
        console.warn(`Starting in emergency mode (${reason})`)
        EmergencyModeStore.set({ reason })
        SafeModeStore.set(true)
    }
}

/** Runs once loading finished: a boot that stays up for a while ends the crash streak. */
export function armBootStableTimer() {
    setTimeout(() => {
        bootGuard.markStable()
    }, BOOT_STABLE_AFTER_MS)
}

/** Gives the save loop time to pick up and write the latest changes before the page goes away. */
async function waitForPendingSave() {
    try {
        const { saving } = await import('./globalApi.svelte')
        //changes are picked up after a 500ms debounce and a 500ms polling interval
        await sleep(1500)
        for (let i = 0; i < 600 && saving.state; i++) {
            await sleep(100)
        }
    } catch (error) {
        console.error(error)
    }
}

/** Saves, then reloads the app in emergency mode (emergency = true) or normally. */
export async function restartApp(emergency: boolean) {
    const storage = getLocalStorage()
    if (emergency) {
        requestEmergencyNextBoot(storage)
    }
    else {
        clearEmergencyNextBoot(storage)
    }
    alertWait(language.emergencyMode.restarting)
    await waitForPendingSave()

    const target = urlWithoutEmergencyParams(location.href)
    if (target !== location.href) {
        location.replace(target)
    }
    else {
        location.reload()
    }
}
