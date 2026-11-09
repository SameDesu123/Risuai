import { describe, expect, it } from 'vitest'
import {
    BOOT_GUARD_KEY,
    BootGuard,
    EMERGENCY_CRASH_THRESHOLD,
    consumeEmergencyNextBoot,
    hasEmergencyUrlParam,
    readBootGuard,
    requestEmergencyNextBoot,
    urlWithoutEmergencyParams,
    type StorageLike,
} from './emergencyBootGuard'

function memoryStorage(): StorageLike & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
        data,
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => { data.set(key, String(value)) },
        removeItem: (key) => { data.delete(key) },
    }
}

/** a boot whose page is killed (OOM) before becoming stable: no further calls */
function crashedBoot(storage: StorageLike) {
    return new BootGuard(storage).begin()
}

describe('BootGuard', () => {
    it('counts nothing on a first boot', () => {
        const storage = memoryStorage()
        expect(new BootGuard(storage).begin()).toBe(0)
        expect(readBootGuard(storage)).toEqual({ pending: true, crashes: 0 })
    })

    it('counts consecutive boots that died before becoming stable', () => {
        const storage = memoryStorage()
        expect(crashedBoot(storage)).toBe(0)
        expect(crashedBoot(storage)).toBe(1)
        expect(crashedBoot(storage)).toBe(2)
        expect(crashedBoot(storage)).toBeGreaterThanOrEqual(EMERGENCY_CRASH_THRESHOLD)
    })

    it('resets the streak once a boot becomes stable', () => {
        const storage = memoryStorage()
        crashedBoot(storage)
        crashedBoot(storage)
        const guard = new BootGuard(storage)
        expect(guard.begin()).toBe(2)
        guard.markStable()
        expect(readBootGuard(storage)).toEqual({ pending: false, crashes: 0 })
        expect(new BootGuard(storage).begin()).toBe(0)
    })

    it('does not count a normal unload or hide before stability as a crash', () => {
        const storage = memoryStorage()
        crashedBoot(storage)
        const guard = new BootGuard(storage)
        expect(guard.begin()).toBe(1)
        guard.suspend()
        //neither a crash nor stability: the streak is kept as it was
        expect(new BootGuard(storage).begin()).toBe(1)
    })

    it('counts a crash again after the page becomes visible again', () => {
        const storage = memoryStorage()
        const guard = new BootGuard(storage)
        guard.begin()
        guard.suspend()
        guard.resume()
        expect(new BootGuard(storage).begin()).toBe(1)
    })

    it('ignores suspend and resume after becoming stable', () => {
        const storage = memoryStorage()
        const guard = new BootGuard(storage)
        guard.begin()
        guard.markStable()
        guard.resume()
        expect(readBootGuard(storage)).toEqual({ pending: false, crashes: 0 })
    })

    it('treats unreadable state as a clean slate', () => {
        const storage = memoryStorage()
        storage.setItem(BOOT_GUARD_KEY, '{not json')
        expect(readBootGuard(storage)).toEqual({ pending: false, crashes: 0 })
        storage.setItem(BOOT_GUARD_KEY, JSON.stringify({ pending: true, crashes: -3 }))
        expect(readBootGuard(storage)).toEqual({ pending: true, crashes: 0 })
    })

    it('works without storage', () => {
        const guard = new BootGuard(null)
        expect(guard.begin()).toBe(0)
        expect(() => {
            guard.suspend()
            guard.resume()
            guard.markStable()
        }).not.toThrow()
    })

    it('survives a storage that throws', () => {
        const storage: StorageLike = {
            getItem: () => { throw new Error('denied') },
            setItem: () => { throw new Error('denied') },
            removeItem: () => { throw new Error('denied') },
        }
        expect(new BootGuard(storage).begin()).toBe(0)
        expect(consumeEmergencyNextBoot(storage)).toBe(false)
    })
})

describe('emergency entry flags', () => {
    it('detects the URL parameters', () => {
        expect(hasEmergencyUrlParam('?emergency')).toBe(true)
        expect(hasEmergencyUrlParam('?a=1&safemode=1')).toBe(true)
        expect(hasEmergencyUrlParam('?mainpage=visited')).toBe(false)
        expect(hasEmergencyUrlParam('')).toBe(false)
    })

    it('removes only the emergency parameters from the URL', () => {
        expect(urlWithoutEmergencyParams('https://risu.example/?emergency&mainpage=1#x'))
            .toBe('https://risu.example/?mainpage=1#x')
        expect(urlWithoutEmergencyParams('https://risu.example/?safemode=1'))
            .toBe('https://risu.example/')
        expect(urlWithoutEmergencyParams('https://risu.example/'))
            .toBe('https://risu.example/')
    })

    it('uses the restart request only once', () => {
        const storage = memoryStorage()
        expect(consumeEmergencyNextBoot(storage)).toBe(false)
        requestEmergencyNextBoot(storage)
        expect(consumeEmergencyNextBoot(storage)).toBe(true)
        expect(consumeEmergencyNextBoot(storage)).toBe(false)
    })
})
