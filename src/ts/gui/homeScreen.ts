import type { character, groupChat } from '../storage/database.svelte'
import { coldStorageHeader } from '../process/coldstorageData'

export interface HomeScreenSettings {
    /** '' (none), a key of homeBackgroundPresets, or 'image' */
    background: string
    /** Saved asset path used when background is 'image' */
    image: string
    /** Overlay a dot-matrix pattern on top of the background */
    dither: boolean
    showRecent: boolean
    showActivity: boolean
    showStats: boolean
    hideLinks: boolean
}

export const defaultHomeScreenSettings: HomeScreenSettings = {
    background: '',
    image: '',
    dither: true,
    showRecent: false,
    showActivity: false,
    showStats: false,
    hideLinks: false,
}

export function normalizeHomeScreenSettings(settings: Partial<HomeScreenSettings> | undefined | null): HomeScreenSettings {
    return { ...defaultHomeScreenSettings, ...(settings ?? {}) }
}

/** Five color stops each, drawn as a diagonal band across the home screen */
export const homeBackgroundPresets = {
    aurora: ['#1e3a8a', '#38bdf8', '#fb923c', '#dc2626', '#450a0a'],
    sunset: ['#7c2d12', '#f97316', '#fbbf24', '#f472b6', '#4c1d95'],
    ocean: ['#082f49', '#0369a1', '#22d3ee', '#a7f3d0', '#064e3b'],
    forest: ['#14532d', '#16a34a', '#bef264', '#facc15', '#713f12'],
    nebula: ['#312e81', '#7c3aed', '#e879f9', '#f43f5e', '#4c0519'],
    mono: ['#262626', '#737373', '#e5e5e5', '#737373', '#262626'],
} as const satisfies Record<string, readonly string[]>

export type HomeBackgroundPreset = keyof typeof homeBackgroundPresets

export const homeBackgroundPresetList = Object.keys(homeBackgroundPresets) as HomeBackgroundPreset[]

export function isHomeBackgroundPreset(value: string): value is HomeBackgroundPreset {
    return Object.prototype.hasOwnProperty.call(homeBackgroundPresets, value)
}

const presetStops = [8, 16, 24, 30, 38]

/** A band running from the upper left down to the right, kept in the upper part of the screen */
export function getPresetGradient(colors: readonly string[]): string {
    const stops = colors.map((color, i) => `${color} ${presetStops[i] ?? 38}%`).join(', ')
    return `linear-gradient(205deg, transparent 0%, ${stops}, transparent 50%)`
}

/** Small dots of the background show through a mask painted in the theme color */
export const homeDitherLayer = 'radial-gradient(circle, transparent 0 0.9px, var(--risu-theme-bgcolor) 1.4px) 0 0 / 4px 4px'

/**
 * Builds the inline style for the home screen background.
 * Returns an empty string when no home background should be drawn.
 */
export function getHomeBackgroundStyle(settings: HomeScreenSettings, imageUrl: string): string {
    let base = ''
    if (settings.background === 'image') {
        if (!imageUrl) {
            return ''
        }
        base = `url("${imageUrl.replace(/"/g, '%22')}") center / cover no-repeat`
    }
    else if (isHomeBackgroundPreset(settings.background)) {
        base = getPresetGradient(homeBackgroundPresets[settings.background])
    }
    else {
        return ''
    }
    const layers = settings.dither ? [homeDitherLayer, base] : [base]
    return `background: ${layers.join(', ')}; background-color: var(--risu-theme-bgcolor);`
}

type AnyCharacter = character | groupChat

export interface HomeRecentCharacter {
    index: number
    name: string
    image: string
    lastInteraction: number
}

export function getRecentCharacters(characters: AnyCharacter[], limit = 8): HomeRecentCharacter[] {
    const list: HomeRecentCharacter[] = []
    for (let i = 0; i < characters.length; i++) {
        const char = characters[i]
        if (!char || char.trashTime || !char.lastInteraction) {
            continue
        }
        list.push({
            index: i,
            name: char.name || 'Unnamed',
            image: char.image ?? '',
            lastInteraction: char.lastInteraction,
        })
    }
    list.sort((a, b) => b.lastInteraction - a.lastInteraction)
    return list.slice(0, limit)
}

export interface HomeActivityDay {
    /** Local midnight of the day */
    time: number
    count: number
    level: 0 | 1 | 2 | 3 | 4
    future: boolean
}

export interface HomeStats {
    /** Columns of seven days, Sunday first */
    weeks: HomeActivityDay[][]
    rangeMessages: number
    activeDays: number
    streak: number
    characters: number
    chats: number
    messages: number
    monthMessages: number
    topModel: string
}

const dayMs = 86400000

export function collectHomeStats(characters: AnyCharacter[], now = Date.now(), weekCount = 20): HomeStats {
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const lastDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (6 - today.getDay()))
    const dayCount = weekCount * 7
    const firstDay = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() - (dayCount - 1))

    // Local midnights, built from calendar dates so DST shifts stay correct
    const bounds: number[] = []
    for (let i = 0; i <= dayCount; i++) {
        bounds.push(new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + i).getTime())
    }
    const rangeStart = bounds[0]
    const rangeEnd = bounds[dayCount]
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).getTime()

    const counts: number[] = new Array(dayCount).fill(0)
    const models = new Map<string, number>()
    let characterCount = 0
    let chatCount = 0
    let messageCount = 0
    let monthMessages = 0

    for (const char of characters) {
        if (!char || char.trashTime) {
            continue
        }
        characterCount++
        // Cold-stored characters only hold a placeholder chat
        if (char.coldstorage) {
            continue
        }
        for (const chat of char.chats ?? []) {
            const messages = chat?.message
            if (!messages) {
                continue
            }
            chatCount++
            if (messages[0]?.data?.startsWith(coldStorageHeader)) {
                continue
            }
            for (const msg of messages) {
                if (!msg) {
                    continue
                }
                messageCount++
                const time = msg.time
                if (!time || time > now) {
                    continue
                }
                if (time >= monthStart) {
                    monthMessages++
                    const model = msg.role === 'char' ? msg.generationInfo?.model : undefined
                    if (model) {
                        models.set(model, (models.get(model) ?? 0) + 1)
                    }
                }
                if (time >= rangeStart && time < rangeEnd) {
                    let idx = Math.min(dayCount - 1, Math.max(0, Math.floor((time - rangeStart) / dayMs)))
                    while (idx > 0 && time < bounds[idx]) {
                        idx--
                    }
                    while (idx < dayCount - 1 && time >= bounds[idx + 1]) {
                        idx++
                    }
                    counts[idx]++
                }
            }
        }
    }

    const max = Math.max(0, ...counts)
    const todayIndex = bounds.indexOf(today.getTime())
    const weeks: HomeActivityDay[][] = []
    let rangeMessages = 0
    let activeDays = 0
    for (let i = 0; i < dayCount; i++) {
        const count = counts[i]
        rangeMessages += count
        if (count > 0) {
            activeDays++
        }
        const level = (count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4))) as HomeActivityDay['level']
        if (i % 7 === 0) {
            weeks.push([])
        }
        weeks[weeks.length - 1].push({
            time: bounds[i],
            count,
            level,
            future: todayIndex >= 0 && i > todayIndex,
        })
    }

    // A streak stays alive until the end of the day after the last active day
    let streak = 0
    if (todayIndex >= 0) {
        let i = counts[todayIndex] > 0 ? todayIndex : todayIndex - 1
        while (i >= 0 && counts[i] > 0) {
            streak++
            i--
        }
    }

    let topModel = ''
    let topModelCount = 0
    for (const [model, count] of models) {
        if (count > topModelCount) {
            topModel = model
            topModelCount = count
        }
    }

    return {
        weeks,
        rangeMessages,
        activeDays,
        streak,
        characters: characterCount,
        chats: chatCount,
        messages: messageCount,
        monthMessages,
        topModel,
    }
}
