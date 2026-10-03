import { describe, expect, it } from 'vitest'

import { usageCsv } from '../csv'
import { localeOf, providerName, usageFormat } from '../format'
import { bucketKey, emptyCounters } from '../types'

describe('localeOf', () => {
    it('maps the language setting to an Intl locale', () => {
        expect(localeOf('ko')).toBe('ko')
        expect(localeOf('cn')).toBe('zh-CN')
        expect(localeOf('zh-Hant')).toBe('zh-TW')
        expect(localeOf('not a locale!')).toBeUndefined()
        expect(localeOf(undefined)).toBeUndefined()
    })
})

describe('usageFormat', () => {
    const format = usageFormat('en')

    it('shows fractions of a cent instead of $0.00', () => {
        expect(format.cost(0)).toBe('$0.00')
        expect(format.cost(0.004234)).toBe('$0.0042')
        expect(format.cost(12.3456)).toBe('$12.35')
    })

    it('shortens token counts', () => {
        expect(format.tokens(950)).toBe('950')
        expect(format.tokens(1_234_567)).toBe('1.2M')
    })

    it('writes the year only when a range crosses years', () => {
        // ICU puts thin spaces around the dash.
        const days = (from: string, to: string) => format.days(from, to).replace(/\s/g, ' ')
        expect(days('2026-09-04', '2026-10-03')).toBe('Sep 4 – Oct 3')
        expect(days('2025-10-04', '2026-10-03')).toBe('Oct 4, 2025 – Oct 3, 2026')
    })
})

describe('providerName', () => {
    const translated = { plugin: 'Plugin', custom: 'Custom endpoint' }

    it('names known providers and keeps custom hosts as they are', () => {
        expect(providerName('vertex', translated)).toBe('Vertex AI')
        expect(providerName('api.groq.com', translated)).toBe('api.groq.com')
        expect(providerName('custom', translated)).toBe('Custom endpoint')
    })
})

describe('usageCsv', () => {
    it('writes a row per day and bucket, with costs where a price is known', () => {
        const priced = bucketKey({ provider: 'anthropic', model: 'claude-x', purpose: 'model' })
        const unpriced = bucketKey({ provider: 'my.host', model: 'odd, "model"', purpose: 'memory' })
        const csv = usageCsv(
            {
                '2026-10-02': { [priced]: { ...emptyCounters(), requests: 1, input: 1000, output: 100 } },
                '2026-10-03': { [unpriced]: { ...emptyCounters(), requests: 2, input: 5 } },
                '2026-09-01': { [priced]: { ...emptyCounters(), requests: 9 } },
            },
            { from: '2026-10-01', to: '2026-10-03' },
            (provider) => (provider === 'anthropic' ? { input: 3, output: 15 } : undefined),
        )

        expect(csv.split('\r\n')).toEqual([
            'date,provider,model,purpose,requests,input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,reasoning_tokens,estimated_requests,cost_usd',
            '2026-10-02,anthropic,claude-x,model,1,1000,0,0,100,0,0,0.004500',
            '2026-10-03,my.host,"odd, ""model""",memory,2,5,0,0,0,0,0,',
            '',
        ])
    })
})
