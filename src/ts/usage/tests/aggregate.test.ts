import { describe, expect, it } from 'vitest'

import {
    buildHeatmap,
    dailyTokens,
    firstUsageDay,
    heatLevels,
    isInSpan,
    rangeSpan,
    summarize,
} from '../aggregate'
import { bucketKey, emptyCounters, type UsageCounters, type UsageDays } from '../types'

const today = new Date(2026, 9, 3) // Saturday, 2026-10-03

function usage(input: number, output: number): UsageCounters {
    return { ...emptyCounters(), requests: 1, input, output }
}

const sonnet = bucketKey({ provider: 'anthropic', model: 'claude-sonnet-4-5', purpose: 'model' })
const sonnetMemory = bucketKey({ provider: 'anthropic', model: 'claude-sonnet-4-5', purpose: 'memory' })
const sonnetRouter = bucketKey({ provider: 'openrouter', model: 'claude-sonnet-4-5', purpose: 'model' })

const days: UsageDays = {
    '2026-10-03': { [sonnet]: usage(1000, 100), [sonnetMemory]: usage(500, 50) },
    '2026-09-28': { [sonnetRouter]: usage(3000, 0) },
    '2025-01-15': { [sonnet]: usage(10, 0) },
}

describe('rangeSpan', () => {
    it('ends today and counts today as the first day', () => {
        expect(rangeSpan('7d', today)).toEqual({ from: '2026-09-27', to: '2026-10-03' })
    })

    it('has no lower bound for all time', () => {
        expect(rangeSpan('all', today)).toEqual({ from: undefined, to: '2026-10-03' })
    })

    it('includes both ends', () => {
        const span = rangeSpan('7d', today)
        expect(isInSpan('2026-09-27', span)).toBe(true)
        expect(isInSpan('2026-09-26', span)).toBe(false)
    })
})

describe('summarize', () => {
    it('keeps providers apart but merges purposes into one model row', () => {
        const summary = summarize(days, rangeSpan('7d', today))

        expect(summary.models.map((m) => [m.provider, m.model])).toEqual([
            ['openrouter', 'claude-sonnet-4-5'],
            ['anthropic', 'claude-sonnet-4-5'],
        ])
        expect(summary.models[1].counters.requests).toBe(2)
        expect(summary.models[1].counters.input).toBe(1500)
        expect(summary.total.counters.input).toBe(4500)
        expect(summary.purposes.map((p) => p.purpose)).toEqual(['model', 'memory'])
    })

    it('only counts days in the span', () => {
        expect(summarize(days, { from: '2026-10-03', to: '2026-10-03' }).total.counters.requests).toBe(2)
        expect(summarize(days, rangeSpan('all', today)).total.counters.requests).toBe(4)
    })

    it('prices each provider on its own and tracks what has no price', () => {
        const summary = summarize(days, rangeSpan('7d', today), (provider) => (
            provider === 'anthropic' ? { input: 3, output: 15 } : undefined
        ))

        // (1500 * 3 + 150 * 15) / 1M
        expect(summary.total.cost).toBeCloseTo(0.00675)
        expect(summary.total.unpricedTokens).toBe(3000)
        expect(summary.models[0].unpricedTokens).toBe(3000)
        expect(summary.models[1].cost).toBeCloseTo(0.00675)
        expect(summary.purposes.find((p) => p.purpose === 'memory').cost).toBeCloseTo((500 * 3 + 50 * 15) / 1e6)
    })
})

describe('heatLevels', () => {
    it('returns 0 for days without usage', () => {
        expect(heatLevels([0, 0])(0)).toBe(0)
        expect(heatLevels([10, 1000])(0)).toBe(0)
    })

    it('spreads the busiest and quietest days over the whole scale', () => {
        const level = heatLevels([10, 100, 1000, 10000])
        expect(level(10)).toBe(1)
        expect(level(10000)).toBe(4)
        expect(level(1000)).toBe(3)
    })

    it('uses the darkest shade when every busy day is the same', () => {
        expect(heatLevels([500, 500])(500)).toBe(4)
    })
})

describe('buildHeatmap', () => {
    it('shows 53 full weeks that end with the current week', () => {
        const heatmap = buildHeatmap(dailyTokens(days), today)

        expect(heatmap.weeks).toHaveLength(53)
        expect(heatmap.weeks.every((week) => week.length === 7)).toBe(true)
        const lastWeek = heatmap.weeks[52]
        expect(lastWeek[0].day).toBe('2026-09-27')
        expect(lastWeek[6].day).toBe('2026-10-03')
        expect(lastWeek[6].tokens).toBe(1650)
        expect(lastWeek[6].level).toBeGreaterThan(0)
    })

    it('marks the days after today', () => {
        const heatmap = buildHeatmap(new Map(), new Date(2026, 9, 1)) // Thursday
        const lastWeek = heatmap.weeks.at(-1)
        expect(lastWeek.map((cell) => cell.inPast)).toEqual([true, true, true, true, true, false, false])
    })

    it('goes back far enough to show the first recorded day', () => {
        const heatmap = buildHeatmap(dailyTokens(days), today, firstUsageDay(days))
        expect(heatmap.weeks[0][0].day).toBe('2025-01-12')
        expect(heatmap.weeks.flat().find((cell) => cell.day === '2025-01-15').tokens).toBe(10)
    })

    it('labels the weeks where months start', () => {
        const heatmap = buildHeatmap(new Map(), today)
        const last = heatmap.months.at(-1)
        expect(heatmap.weeks[last.week].some((cell) => cell.day === '2026-10-01')).toBe(true)
    })
})
