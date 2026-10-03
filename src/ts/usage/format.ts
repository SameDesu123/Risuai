import { fromDayKey } from './types'

/** The Intl locale for RisuAI's language setting. */
export function localeOf(language: string | undefined): string | undefined {
    const aliases: Record<string, string> = { cn: 'zh-CN', 'zh-Hant': 'zh-TW' }
    try {
        return Intl.getCanonicalLocales(aliases[language] ?? language)[0]
    } catch {
        return undefined
    }
}

/** Number and date formats of the usage page. Made once per language, since Intl formatters are slow to create. */
export function usageFormat(locale: string | undefined) {
    const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
    const whole = new Intl.NumberFormat(locale)
    const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
    const dollars = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' })
    // A cheap request costs a fraction of a cent, which two decimals would show as $0.00.
    const cents = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        currencyDisplay: 'narrowSymbol',
        maximumSignificantDigits: 2,
    })
    const longDate = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
    // Adds the year by itself when a range crosses years.
    const shortDate = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
    const month = new Intl.DateTimeFormat(locale, { month: 'short' })
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' })

    return {
        tokens: (count: number) => compact.format(count),
        count: (count: number) => whole.format(count),
        percent: (ratio: number) => percent.format(ratio),
        cost: (amount: number) => (amount > 0 && amount < 0.01 ? cents : dollars).format(amount),
        day: (day: string) => longDate.format(fromDayKey(day)),
        days: (from: string, to: string) => shortDate.formatRange(fromDayKey(from), fromDayKey(to)),
        month: (date: Date) => month.format(date),
        weekday: (date: Date) => weekday.format(date),
    }
}

export type UsageFormat = ReturnType<typeof usageFormat>

const providerNames: Record<string, string> = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google AI Studio',
    vertex: 'Vertex AI',
    aws: 'AWS Bedrock',
    mistral: 'Mistral',
    novellist: 'NovelList',
    cohere: 'Cohere',
    novelai: 'NovelAI',
    webllm: 'WebLLM',
    horde: 'AI Horde',
    deepseek: 'DeepSeek',
    deepinfra: 'DeepInfra',
    nanogpt: 'NanoGPT',
    ollama: 'Ollama',
    'ollama-cloud': 'Ollama Cloud',
    openrouter: 'OpenRouter',
}

/** The name to show for a provider of `usageSource`. Custom endpoints are already named by their host. */
export function providerName(provider: string, translated: { plugin: string, custom: string }): string {
    if(provider === 'plugin' || provider === 'custom'){
        return translated[provider]
    }
    return providerNames[provider] ?? provider
}
