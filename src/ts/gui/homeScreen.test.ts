import { describe, expect, it } from 'vitest'
import { coldStorageHeader } from '../process/coldstorageData'
import {
    collectHomeStats,
    defaultHomeScreenSettings,
    getHomeBackgroundStyle,
    getRecentCharacters,
    homeDitherLayer,
    homePresetVeilLayer,
    normalizeHomeScreenSettings,
} from './homeScreen'

// Wednesday, 2026-11-18 15:00 local time
const now = new Date(2026, 10, 18, 15, 0, 0).getTime()
const at = (month: number, day: number, hour = 12) => new Date(2026, month, day, hour).getTime()

function char(name: string, extra: Record<string, unknown> = {}, messages: Record<string, unknown>[][] = []) {
    return {
        type: 'character',
        name,
        image: '',
        chats: messages.map((message) => ({ message, note: '', name: '', localLore: [] })),
        ...extra,
    } as any
}

describe('homeScreen settings', () => {
    it('fills missing fields with defaults', () => {
        expect(normalizeHomeScreenSettings(undefined)).toEqual(defaultHomeScreenSettings)
        expect(normalizeHomeScreenSettings({ showRecent: true }).showRecent).toBe(true)
        expect(normalizeHomeScreenSettings({ showRecent: true }).dither).toBe(true)
    })

    it('builds background styles for presets and images', () => {
        const base = normalizeHomeScreenSettings({})
        expect(getHomeBackgroundStyle(base, '')).toBe('')
        expect(getHomeBackgroundStyle({ ...base, background: 'unknown' }, '')).toBe('')

        const aurora = getHomeBackgroundStyle({ ...base, background: 'aurora' }, '')
        expect(aurora).toContain(homeDitherLayer)
        expect(aurora).toContain('#1e3a8a 0%')
        expect(aurora).toContain('#450a0a 100%')
        expect(aurora).not.toContain(homePresetVeilLayer)

        const plain = getHomeBackgroundStyle({ ...base, background: 'aurora', dither: false }, '')
        expect(plain).not.toContain(homeDitherLayer)
        expect(plain).toContain(homePresetVeilLayer)

        expect(getHomeBackgroundStyle({ ...base, background: 'image' }, '')).toBe('')
        expect(getHomeBackgroundStyle({ ...base, background: 'image' }, 'blob:a"b')).toContain('url("blob:a%22b")')
        const plainImage = getHomeBackgroundStyle({ ...base, background: 'image', dither: false }, 'blob:x')
        expect(plainImage).not.toContain(homePresetVeilLayer)
    })
})

describe('getRecentCharacters', () => {
    it('sorts by last interaction and skips trashed or untouched characters', () => {
        const list = getRecentCharacters([
            char('old', { lastInteraction: 10 }),
            char('never'),
            char('trashed', { lastInteraction: 99, trashTime: 1 }),
            char('new', { lastInteraction: 50 }),
        ])
        expect(list.map((c) => c.name)).toEqual(['new', 'old'])
        expect(list[0].index).toBe(3)
    })
})

describe('collectHomeStats', () => {
    it('bins messages by local day and computes totals', () => {
        const stats = collectHomeStats([
            char('a', {}, [[
                { role: 'user', data: 'hi', time: at(10, 18, 9) },
                { role: 'char', data: 'yo', time: at(10, 18, 9), generationInfo: { model: 'model-x' } },
                { role: 'user', data: 'hi', time: at(10, 17) },
                { role: 'user', data: 'old', time: at(10, 1) },
                { role: 'user', data: 'no time' },
            ]]),
            char('b', {}, [[
                { role: 'char', data: 'y', time: at(10, 16), generationInfo: { model: 'model-y' } },
            ]]),
        ], now)

        expect(stats.characters).toBe(2)
        expect(stats.chats).toBe(2)
        expect(stats.messages).toBe(6)
        expect(stats.monthMessages).toBe(5)
        expect(stats.topModel).toBe('model-x')
        expect(stats.streak).toBe(3)
        expect(stats.activeDays).toBe(4)
        expect(stats.rangeMessages).toBe(5)

        expect(stats.weeks).toHaveLength(20)
        expect(stats.weeks.every((week) => week.length === 7)).toBe(true)
        const lastWeek = stats.weeks[19]
        // Sunday 2026-11-15 .. Saturday 2026-11-21
        expect(lastWeek[0].time).toBe(new Date(2026, 10, 15).getTime())
        expect(lastWeek[3].count).toBe(2)
        expect(lastWeek[3].level).toBe(4)
        expect(lastWeek[3].future).toBe(false)
        expect(lastWeek[4].future).toBe(true)
    })

    it('keeps the streak alive when today has no messages yet', () => {
        const stats = collectHomeStats([
            char('a', {}, [[
                { role: 'user', data: 'a', time: at(10, 17) },
                { role: 'user', data: 'b', time: at(10, 16) },
            ]]),
        ], now)
        expect(stats.streak).toBe(2)
    })

    it('ignores trashed characters and cold storage placeholders', () => {
        const stats = collectHomeStats([
            char('trashed', { trashTime: 1 }, [[{ role: 'user', data: 'x', time: at(10, 18) }]]),
            char('cold', { coldstorage: 'key' }, [[{ role: 'char', data: '', time: at(10, 18) }]]),
            char('coldChat', {}, [[{ role: 'char', data: coldStorageHeader + 'key', time: at(10, 18) }]]),
        ], now)
        expect(stats.characters).toBe(2)
        expect(stats.chats).toBe(1)
        expect(stats.messages).toBe(0)
        expect(stats.rangeMessages).toBe(0)
        expect(stats.streak).toBe(0)
    })
})
