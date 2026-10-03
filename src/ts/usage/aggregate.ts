import { costOf, type ModelPrice } from './pricing'
import {
    addCounters,
    emptyCounters,
    fromDayKey,
    modelKey,
    parseBucketKey,
    toDayKey,
    totalTokens,
    type UsageCounters,
    type UsageDays,
    type UsagePurpose,
} from './types'

export type UsageRangeId = '7d' | '2w' | '1m' | '3m' | '6m' | '1y' | 'all'

/** Rolling windows that end today. A single day is picked on the heatmap instead. */
export const usageRanges: { id: UsageRangeId, days: number }[] = [
    { id: '7d', days: 7 },
    { id: '2w', days: 14 },
    { id: '1m', days: 30 },
    { id: '3m', days: 90 },
    { id: '6m', days: 180 },
    { id: '1y', days: 365 },
    { id: 'all', days: Infinity },
]

/** Inclusive day span, as day keys. `from` is undefined when there is no lower bound. */
export interface DaySpan {
    from?: string
    to: string
}

export function addDays(date: Date, days: number): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

export function rangeSpan(range: UsageRangeId, today: Date): DaySpan {
    const days = usageRanges.find((r) => r.id === range)?.days ?? Infinity
    return {
        from: Number.isFinite(days) ? toDayKey(addDays(today, 1 - days)) : undefined,
        to: toDayKey(today),
    }
}

export function isInSpan(day: string, span: DaySpan): boolean {
    // Day keys are zero-padded, so they compare correctly as strings.
    return (span.from === undefined || day >= span.from) && day <= span.to
}

/** Usage with its cost. */
export interface UsageTotal {
    counters: UsageCounters
    /** Dollars, counting only the models that have a price. */
    cost: number
    /** Tokens of models without a price. When above zero, `cost` is too low. */
    unpricedTokens: number
}

export interface ModelUsage extends UsageTotal {
    provider: string
    model: string
}

export interface PurposeUsage extends UsageTotal {
    purpose: UsagePurpose
}

export interface UsageSummary {
    total: UsageTotal
    /** One entry per provider + model, most tokens first. */
    models: ModelUsage[]
    purposes: PurposeUsage[]
}

export type PriceLookup = (provider: string, model: string) => ModelPrice | undefined

function emptyTotal(): UsageTotal {
    return { counters: emptyCounters(), cost: 0, unpricedTokens: 0 }
}

function addToTotal(total: UsageTotal, counters: UsageCounters, price: ModelPrice | undefined) {
    addCounters(total.counters, counters)
    if(price){
        total.cost += costOf(counters, price)
    }
    else{
        total.unpricedTokens += totalTokens(counters)
    }
}

export function summarize(days: UsageDays, span: DaySpan, priceOf: PriceLookup = () => undefined): UsageSummary {
    const total = emptyTotal()
    const models = new Map<string, ModelUsage>()
    const purposes = new Map<UsagePurpose, PurposeUsage>()

    for(const [day, buckets] of Object.entries(days)){
        if(!isInSpan(day, span)){
            continue
        }
        for(const [key, counters] of Object.entries(buckets)){
            const { provider, model, purpose } = parseBucketKey(key)
            const id = modelKey(provider, model)
            if(!models.has(id)){
                models.set(id, { provider, model, ...emptyTotal() })
            }
            if(!purposes.has(purpose)){
                purposes.set(purpose, { purpose, ...emptyTotal() })
            }

            const price = priceOf(provider, model)
            addToTotal(total, counters, price)
            addToTotal(models.get(id), counters, price)
            addToTotal(purposes.get(purpose), counters, price)
        }
    }

    const byTokens = (a: UsageTotal, b: UsageTotal) => totalTokens(b.counters) - totalTokens(a.counters)
    return {
        total,
        models: [...models.values()].sort(byTokens),
        purposes: [...purposes.values()].sort(byTokens),
    }
}

/** Total tokens of each day that has usage. */
export function dailyTokens(days: UsageDays): Map<string, number> {
    const result = new Map<string, number>()
    for(const [day, buckets] of Object.entries(days)){
        let tokens = 0
        for(const counters of Object.values(buckets)){
            tokens += totalTokens(counters)
        }
        if(tokens > 0){
            result.set(day, tokens)
        }
    }
    return result
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4

/**
 * Maps token counts to shades 1-4 (0 is no usage). The quietest busy day gets 1 and the busiest gets 4.
 * The scale is logarithmic because daily usage easily spans several orders of magnitude.
 */
export function heatLevels(values: Iterable<number>): (tokens: number) => HeatLevel {
    const busy = [...values].filter((v) => v > 0)
    if(busy.length === 0){
        return () => 0
    }
    const low = Math.log(Math.min(...busy))
    const high = Math.log(Math.max(...busy))

    return (tokens) => {
        if(tokens <= 0){
            return 0
        }
        if(high === low){
            return 4
        }
        const position = Math.min(1, Math.max(0, (Math.log(tokens) - low) / (high - low)))
        return (1 + Math.min(3, Math.floor(position * 4))) as HeatLevel
    }
}

export interface HeatmapCell {
    day: string
    tokens: number
    level: HeatLevel
    /** False for the days after today in the last week. */
    inPast: boolean
}

export interface Heatmap {
    /** Columns of seven days, Sunday first. */
    weeks: HeatmapCell[][]
    /** The weeks where a month starts, for the labels above the grid. */
    months: { week: number, date: Date }[]
}

/** A GitHub-style calendar: the last 53 weeks, or back to `firstDay` when that is earlier. */
export function buildHeatmap(tokensByDay: Map<string, number>, today: Date, firstDay?: string): Heatmap {
    const thisSunday = addDays(today, -today.getDay())
    let start = addDays(thisSunday, -52 * 7)
    if(firstDay && fromDayKey(firstDay) < start){
        const first = fromDayKey(firstDay)
        start = addDays(first, -first.getDay())
    }

    const todayKey = toDayKey(today)
    const cells: HeatmapCell[] = []
    for(let date = start; date <= addDays(thisSunday, 6); date = addDays(date, 1)){
        const day = toDayKey(date)
        cells.push({ day, tokens: tokensByDay.get(day) ?? 0, level: 0, inPast: day <= todayKey })
    }

    const level = heatLevels(cells.map((cell) => cell.tokens))
    const weeks: HeatmapCell[][] = []
    const months: Heatmap['months'] = []
    for(let i = 0; i < cells.length; i += 7){
        const week = cells.slice(i, i + 7)
        for(const cell of week){
            cell.level = level(cell.tokens)
        }
        const firstOfMonth = week.find((cell) => cell.day.endsWith('-01'))
        if(firstOfMonth){
            months.push({ week: weeks.length, date: fromDayKey(firstOfMonth.day) })
        }
        weeks.push(week)
    }
    return { weeks, months }
}

/** The earliest day with recorded usage. */
export function firstUsageDay(days: UsageDays): string | undefined {
    let first: string | undefined
    for(const day of Object.keys(days)){
        if(first === undefined || day < first){
            first = day
        }
    }
    return first
}
