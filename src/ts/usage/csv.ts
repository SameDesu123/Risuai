import { isInSpan, type DaySpan, type PriceLookup } from './aggregate'
import { costOf } from './pricing'
import { parseBucketKey, type UsageDays } from './types'

const columns = [
    'date', 'provider', 'model', 'purpose', 'requests',
    'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'output_tokens', 'reasoning_tokens',
    'estimated_requests', 'cost_usd',
]

/** One row per day, provider, model and purpose. The cost is left empty for models without a price. */
export function usageCsv(days: UsageDays, span: DaySpan, priceOf: PriceLookup): string {
    const rows: (string | number)[][] = [columns]
    for(const day of Object.keys(days).filter((day) => isInSpan(day, span)).sort()){
        for(const [key, counters] of Object.entries(days[day])){
            const { provider, model, purpose } = parseBucketKey(key)
            const price = priceOf(provider, model)
            rows.push([
                day, provider, model, purpose, counters.requests,
                counters.input, counters.cacheRead, counters.cacheWrite, counters.output, counters.reasoning,
                counters.estimated, price ? costOf(counters, price).toFixed(6) : '',
            ])
        }
    }
    return rows.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n'
}

function csvField(value: string | number): string {
    const text = String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
