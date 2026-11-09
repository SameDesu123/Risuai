/**
 * Whether this session runs in emergency mode, and the display settings it forces on.
 *
 * Emergency mode is decided once at startup, before the save is loaded, and stays the same
 * until the page reloads. Kept free of app imports so the parser and other low-level modules
 * can use it; starting and leaving emergency mode lives in emergencyMode.ts.
 */
import { get, writable } from "svelte/store"

export type EmergencyModeReason = 'url' | 'manual' | 'crash'

/** null while emergency mode is off */
export const EmergencyModeStore = writable<{ reason: EmergencyModeReason } | null>(null)

export function isEmergencyMode(): boolean {
    return get(EmergencyModeStore) !== null
}

/**
 * The "Hide All Images" setting as it applies right now: emergency mode turns it on
 * for its session without changing the saved setting.
 */
export function shouldHideAllImages(db: { hideAllImages?: boolean } | null | undefined): boolean {
    return isEmergencyMode() || db?.hideAllImages === true
}

/**
 * The "Hide RisuRealm" setting as it applies right now: emergency mode turns it on
 * for its session without changing the saved setting.
 */
export function shouldHideRealm(db: { hideRealm?: boolean } | null | undefined): boolean {
    return isEmergencyMode() || db?.hideRealm === true
}
