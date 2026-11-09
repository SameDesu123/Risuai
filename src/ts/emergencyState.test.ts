import { afterEach, describe, expect, it } from 'vitest'
import {
    EmergencyModeStore,
    isEmergencyMode,
    shouldHideAllImages,
    shouldHideRealm,
} from './emergencyState'

afterEach(() => {
    EmergencyModeStore.set(null)
})

describe('emergency display overrides', () => {
    it('follows the saved settings outside emergency mode', () => {
        expect(isEmergencyMode()).toBe(false)
        expect(shouldHideAllImages({ hideAllImages: false })).toBe(false)
        expect(shouldHideAllImages({ hideAllImages: true })).toBe(true)
        expect(shouldHideRealm({ hideRealm: false })).toBe(false)
        expect(shouldHideRealm({ hideRealm: true })).toBe(true)
        expect(shouldHideAllImages(undefined)).toBe(false)
        expect(shouldHideRealm(null)).toBe(false)
    })

    it('hides images and RisuRealm in emergency mode whatever the settings say', () => {
        EmergencyModeStore.set({ reason: 'manual' })
        expect(isEmergencyMode()).toBe(true)
        expect(shouldHideAllImages({ hideAllImages: false })).toBe(true)
        expect(shouldHideRealm({ hideRealm: false })).toBe(true)
        expect(shouldHideAllImages(undefined)).toBe(true)
        expect(shouldHideRealm(null)).toBe(true)
    })

    it('does not change the settings it overrides', () => {
        EmergencyModeStore.set({ reason: 'crash' })
        const db = { hideAllImages: false, hideRealm: false }
        shouldHideAllImages(db)
        shouldHideRealm(db)
        expect(db).toEqual({ hideAllImages: false, hideRealm: false })
    })
})
