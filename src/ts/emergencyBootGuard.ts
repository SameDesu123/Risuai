/**
 * Crash detection and entry flags for emergency mode.
 *
 * A renderer that runs out of memory is killed without running any more script, so a boot
 * that died can only be recognized by the next one. Every boot marks itself as pending, and
 * only a boot that stays up long enough after loading (markStable) or leaves through a normal
 * page unload / hide (suspend) clears the mark. A pending mark found at boot is one crash.
 *
 * Kept free of app imports so it can be tested on its own.
 */

export const BOOT_GUARD_KEY = 'risu-boot-guard'
export const EMERGENCY_NEXT_BOOT_KEY = 'risu-emergency-next-boot'
/** consecutive boots that died before becoming stable, after which emergency mode is offered */
export const EMERGENCY_CRASH_THRESHOLD = 2
/** how long the app must stay up after loading for a boot to count as stable */
export const BOOT_STABLE_AFTER_MS = 30_000
/** `?emergency` or `?safemode` in the URL starts emergency mode directly */
export const EMERGENCY_URL_PARAMS = ['emergency', 'safemode'] as const

export type BootGuardState = {
    /** a boot is running that has neither become stable nor left normally */
    pending: boolean
    /** consecutive boots that died before becoming stable */
    crashes: number
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function readBootGuard(storage: StorageLike | null): BootGuardState {
    try {
        const raw = storage?.getItem(BOOT_GUARD_KEY)
        if (!raw) {
            return { pending: false, crashes: 0 }
        }
        const parsed = JSON.parse(raw)
        const crashes = Number(parsed?.crashes)
        return {
            pending: parsed?.pending === true,
            crashes: Number.isFinite(crashes) && crashes > 0 ? Math.floor(crashes) : 0
        }
    } catch {
        return { pending: false, crashes: 0 }
    }
}

function writeBootGuard(storage: StorageLike | null, state: BootGuardState) {
    try {
        storage?.setItem(BOOT_GUARD_KEY, JSON.stringify(state))
    } catch {
        //storage full or unavailable: crash detection just stays off
    }
}

export class BootGuard {
    private crashes = 0
    private stable = false
    private begun = false

    constructor(private storage: StorageLike | null) {}

    /**
     * Marks this boot as pending. Returns how many boots in a row died before becoming stable,
     * counting the one right before this boot.
     */
    begin(): number {
        const prev = readBootGuard(this.storage)
        this.crashes = prev.pending ? prev.crashes + 1 : prev.crashes
        this.begun = true
        writeBootGuard(this.storage, { pending: true, crashes: this.crashes })
        return this.crashes
    }

    /** The app stayed up long enough: the crash streak is over. */
    markStable() {
        if (!this.begun) {
            return
        }
        this.stable = true
        this.crashes = 0
        writeBootGuard(this.storage, { pending: false, crashes: 0 })
    }

    /** The page is being unloaded or hidden normally: that is not a crash, but not stability either. */
    suspend() {
        if (!this.begun || this.stable) {
            return
        }
        writeBootGuard(this.storage, { pending: false, crashes: this.crashes })
    }

    /** The page is visible again before becoming stable. */
    resume() {
        if (!this.begun || this.stable) {
            return
        }
        writeBootGuard(this.storage, { pending: true, crashes: this.crashes })
    }

    get isStable() {
        return this.stable
    }
}

export function hasEmergencyUrlParam(search: string): boolean {
    try {
        const params = new URLSearchParams(search)
        return EMERGENCY_URL_PARAMS.some((key) => params.has(key))
    } catch {
        return false
    }
}

/** The URL to reload into when leaving emergency mode, without the parameters that start it. */
export function urlWithoutEmergencyParams(href: string): string {
    try {
        const url = new URL(href)
        for (const key of EMERGENCY_URL_PARAMS) {
            url.searchParams.delete(key)
        }
        return url.toString()
    } catch {
        return href
    }
}

/** Asks the next boot to start in emergency mode (once). */
export function requestEmergencyNextBoot(storage: StorageLike | null) {
    try {
        storage?.setItem(EMERGENCY_NEXT_BOOT_KEY, '1')
    } catch {}
}

/** Reads and clears the one-shot request left by requestEmergencyNextBoot. */
export function consumeEmergencyNextBoot(storage: StorageLike | null): boolean {
    try {
        const requested = storage?.getItem(EMERGENCY_NEXT_BOOT_KEY) === '1'
        if (requested) {
            storage?.removeItem(EMERGENCY_NEXT_BOOT_KEY)
        }
        return requested
    } catch {
        return false
    }
}

export function clearEmergencyNextBoot(storage: StorageLike | null) {
    try {
        storage?.removeItem(EMERGENCY_NEXT_BOOT_KEY)
    } catch {}
}
