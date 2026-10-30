// Static WCAG 2.2 AA contrast checks for the built-in color presets.
//
// Known failures are recorded in contrastBaseline.json. The test fails when a
// check fails that is not in the baseline, or when a baseline entry now passes
// (remove it). To regenerate the baseline after intentional color changes:
//
//     UPDATE_CONTRAST_BASELINE=1 pnpm test:contrast
//
// Ratios in the baseline are rounded for readability only; pass/fail is always
// decided on the raw ratio.

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { colorSchemePresets, textThemePresets, type ColorScheme } from './colorschemePresets'
import { contrastRatio, meetsContrast, parseHexColor, relativeLuminance } from './contrast'

const TEXT_MIN = 4.5
const NON_TEXT_MIN = 3

type ColorToken = Exclude<keyof ColorScheme, 'type'>

interface ContrastCheck {
    id: string
    fg: string
    bg: string
    min: number
}

const textPairs: [ColorToken, ColorToken][] = [
    ['textcolor', 'bgcolor'],
    ['textcolor', 'darkbg'],
    ['textcolor', 'selected'],
    ['textcolor', 'darkbutton'],
    ['textcolor2', 'bgcolor'],
    ['textcolor2', 'darkbg'],
    ['textcolor2', 'selected'],
    ['textcolor2', 'darkbutton'],
    ['draculared', 'bgcolor'],
    ['draculared', 'darkbg'],
    // `bg-textcolor2 text-textcolor` pattern
    ['textcolor', 'textcolor2'],
]

const nonTextPairs: [ColorToken, ColorToken][] = [
    ['borderc', 'bgcolor'],
    ['borderc', 'darkbg'],
    ['darkBorderc', 'bgcolor'],
    ['darkBorderc', 'darkbg'],
    ['selected', 'bgcolor'],
    ['darkbutton', 'bgcolor'],
    ['darkbutton', 'darkbg'],
]

function buildChecks(): ContrastCheck[] {
    const checks: ContrastCheck[] = []
    for (const [name, scheme] of Object.entries(colorSchemePresets) as [string, ColorScheme][]) {
        for (const [fg, bg] of textPairs) {
            checks.push({ id: `${name}:text:${fg}/${bg}`, fg: scheme[fg], bg: scheme[bg], min: TEXT_MIN })
        }
        for (const [fg, bg] of nonTextPairs) {
            checks.push({ id: `${name}:nontext:${fg}/${bg}`, fg: scheme[fg], bg: scheme[bg], min: NON_TEXT_MIN })
        }
        for (const [textTheme, palettes] of Object.entries(textThemePresets)) {
            for (const [role, color] of Object.entries(palettes[scheme.type])) {
                for (const bg of ['bgcolor', 'darkbg'] as const) {
                    checks.push({ id: `${name}:chat:${textTheme}:${role}/${bg}`, fg: color, bg: scheme[bg], min: TEXT_MIN })
                }
            }
        }
    }
    return checks
}

const baselinePath = resolve(process.cwd(), 'src/ts/gui/contrastBaseline.json')

describe('contrast helpers', () => {
    it('parses short and long hex colors', () => {
        expect(parseHexColor('#fff')).toEqual([255, 255, 255])
        expect(parseHexColor('#1A2b3C')).toEqual([26, 43, 60])
    })

    it('rejects anything that is not #rgb or #rrggbb', () => {
        for (const bad of ['fff', '#ffff', '#fffffff', '#ggg', 'rgb(0,0,0)', 'red', '']) {
            expect(() => parseHexColor(bad)).toThrow()
        }
    })

    it('computes relative luminance at the extremes', () => {
        expect(relativeLuminance('#000')).toBe(0)
        expect(relativeLuminance('#ffffff')).toBe(1)
    })

    it('gives 21:1 for black on white in either order', () => {
        expect(contrastRatio('#000', '#fff')).toBe(21)
        expect(contrastRatio('#fff', '#000')).toBe(21)
    })

    it('passes #767676 on white and fails #777777 on white', () => {
        expect(meetsContrast(contrastRatio('#767676', '#ffffff'), TEXT_MIN)).toBe(true)
        // ~4.48, which would round up to 4.5 at one decimal
        expect(meetsContrast(contrastRatio('#777777', '#ffffff'), TEXT_MIN)).toBe(false)
    })

    it('treats values just under the threshold as failing', () => {
        expect(meetsContrast(4.499, TEXT_MIN)).toBe(false)
        expect(meetsContrast(4.4999999, TEXT_MIN)).toBe(false)
        expect(meetsContrast(2.9999, NON_TEXT_MIN)).toBe(false)
        expect(meetsContrast(4.5, TEXT_MIN)).toBe(true)
    })
})

describe('color scheme presets contrast', () => {
    const checks = buildChecks()

    it('has unique check ids', () => {
        expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length)
    })

    it('matches the committed baseline of known failures', () => {
        const failures: Record<string, number> = {}
        for (const check of checks.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
            const ratio = contrastRatio(check.fg, check.bg)
            if (!meetsContrast(ratio, check.min)) {
                failures[check.id] = Math.round(ratio * 100) / 100
            }
        }

        if (process.env.UPDATE_CONTRAST_BASELINE) {
            writeFileSync(baselinePath, JSON.stringify(failures, null, 4) + '\n')
            return
        }

        const baseline: Record<string, number> = JSON.parse(readFileSync(baselinePath, 'utf-8'))
        const newFailures = Object.keys(failures).filter((id) => !(id in baseline))
        const staleEntries = Object.keys(baseline).filter((id) => !(id in failures))

        // newFailures: fix the colors or regenerate the baseline.
        // staleEntries: these now pass; remove them from the baseline.
        expect({ newFailures, staleEntries }).toEqual({ newFailures: [], staleEntries: [] })
    })
})
