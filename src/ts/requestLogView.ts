/**
 * Helpers that turn raw fetch log entries into something easy to inspect
 * in the request log viewer (model name, token usage,
 * error message, masked secrets, cURL export...).
 *
 * Everything here is pure and defensive: logs can contain any shape of
 * body/response (JSON, SSE text, plain strings), so every parser must
 * fall back gracefully instead of throwing.
 */

export interface RequestLogEntry {
    body: string
    header: string
    response: string
    success: boolean
    date: string
    url: string
    responseType?: string
    chatId?: string
    status?: number
}

export interface LogUsage {
    input?: number
    output?: number
    total?: number
}

export interface LogSummary {
    host: string
    path: string
    model: string | null
    stream: boolean
    bodySize: number
    responseSize: number
    usage: LogUsage | null
    errorMessage: string | null
}

const SECRET_HEADER_RE = /authorization|api[-_]?key|token|secret|cookie|password/i
const SECRET_QUERY_RE = /^(key|api[-_]?key|token|access[-_]?token|secret)$/i

export function tryParseJSON(text: string): any {
    if (typeof text !== 'string') {
        return text
    }
    const trimmed = text.trim()
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[' && trimmed[0] !== '"')) {
        return undefined
    }
    try {
        let parsed = JSON.parse(trimmed)
        // Some logs are double encoded (JSON.stringify of a JSON string)
        if (typeof parsed === 'string') {
            const inner = parsed.trim()
            if (inner[0] === '{' || inner[0] === '[') {
                try {
                    parsed = JSON.parse(inner)
                } catch {
                    // keep the string
                }
            }
        }
        return parsed
    } catch {
        return undefined
    }
}

/** Pretty prints JSON text; returns the original text when it is not JSON. */
export function prettyJSON(text: string): string {
    const parsed = tryParseJSON(text)
    if (parsed === undefined || typeof parsed === 'string') {
        return typeof parsed === 'string' ? parsed : text
    }
    return JSON.stringify(parsed, null, 2)
}

export function maskSecret(value: string): string {
    if (typeof value !== 'string') {
        return value
    }
    const bearer = value.match(/^(Bearer|Basic|Token)\s+(.*)$/i)
    if (bearer) {
        return `${bearer[1]} ${maskSecret(bearer[2])}`
    }
    if (value.length <= 8) {
        return '••••••••'
    }
    return `${value.slice(0, 4)}••••••••${value.slice(-4)}`
}

export function maskUrl(url: string): string {
    try {
        const u = new URL(url)
        let changed = false
        for (const [k, v] of u.searchParams) {
            if (SECRET_QUERY_RE.test(k)) {
                u.searchParams.set(k, maskSecret(v))
                changed = true
            }
        }
        return changed ? decodeURIComponent(u.toString()) : url
    } catch {
        return url
    }
}

/** Returns the header JSON text with secret values masked. */
export function maskHeaders(headerText: string): string {
    const parsed = tryParseJSON(headerText)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return headerText
    }
    const out: Record<string, any> = {}
    for (const key of Object.keys(parsed)) {
        const v = parsed[key]
        out[key] = SECRET_HEADER_RE.test(key) && typeof v === 'string' ? maskSecret(v) : v
    }
    return JSON.stringify(out, null, 2)
}

export function splitUrl(url: string): { host: string, path: string } {
    try {
        const u = new URL(url)
        return { host: u.host, path: u.pathname + (u.search ? '?…' : '') }
    } catch {
        return { host: '', path: url }
    }
}

export function extractModel(body: any, url: string): string | null {
    if (body && typeof body === 'object' && typeof body.model === 'string') {
        return body.model
    }
    const m = url.match(/\/models\/([^/:?]+)/)
    if (m) {
        return decodeURIComponent(m[1])
    }
    return null
}

function num(v: any): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function extractUsage(response: any): LogUsage | null {
    if (!response || typeof response !== 'object') {
        return null
    }
    const u = response.usage ?? response.usageMetadata ?? response.response?.usage
    if (!u || typeof u !== 'object') {
        return null
    }
    const input = num(u.prompt_tokens) ?? num(u.input_tokens) ?? num(u.promptTokenCount)
    const output = num(u.completion_tokens) ?? num(u.output_tokens) ?? num(u.candidatesTokenCount)
    let total = num(u.total_tokens) ?? num(u.totalTokenCount)
    if (total === undefined && input !== undefined && output !== undefined) {
        total = input + output
    }
    if (input === undefined && output === undefined && total === undefined) {
        return null
    }
    return { input, output, total }
}

export function extractErrorMessage(response: any, raw: string): string {
    if (response && typeof response === 'object') {
        const e = response.error ?? response
        if (typeof e === 'string') return e
        if (typeof e?.message === 'string') return e.message
        if (typeof e?.error?.message === 'string') return e.error.message
        if (typeof response.detail === 'string') return response.detail
    }
    if (typeof response === 'string' && response) {
        return response.slice(0, 500)
    }
    return (raw ?? '').slice(0, 500)
}

export function byteSize(text: string): number {
    if (!text) return 0
    try {
        return new TextEncoder().encode(text).length
    } catch {
        return text.length
    }
}

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

const summaryCache = new WeakMap<RequestLogEntry, LogSummary>()

export function summarizeLog(log: RequestLogEntry): LogSummary {
    const cached = summaryCache.get(log)
    if (cached) return cached

    const body = tryParseJSON(log.body)
    const response = tryParseJSON(log.response)
    const { host, path } = splitUrl(log.url)

    const summary: LogSummary = {
        host,
        path,
        model: extractModel(body, log.url),
        stream: body?.stream === true || /stream/i.test(log.url) || log.responseType === 'stream',
        bodySize: byteSize(log.body),
        responseSize: byteSize(log.response),
        usage: extractUsage(response),
        errorMessage: log.success ? null : extractErrorMessage(response, log.response),
    }
    summaryCache.set(log, summary)
    return summary
}

function shellQuote(text: string): string {
    return `'${text.replace(/'/g, `'\\''`)}'`
}

/** Builds a cURL command for reproducing the request. */
export function buildCurl(log: RequestLogEntry, revealSecrets: boolean): string {
    const url = revealSecrets ? log.url : maskUrl(log.url)
    const headerText = revealSecrets ? log.header : maskHeaders(log.header)
    const headers = tryParseJSON(headerText)
    const lines = [`curl ${shellQuote(url)}`]
    const hasBody = !!log.body && log.body !== 'undefined' && log.body !== '{}'
    if (hasBody) {
        lines.push('-X POST')
    }
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
        for (const key of Object.keys(headers)) {
            lines.push(`-H ${shellQuote(`${key}: ${headers[key]}`)}`)
        }
    }
    if (hasBody) {
        const parsed = tryParseJSON(log.body)
        const compact = parsed !== undefined && typeof parsed !== 'string' ? JSON.stringify(parsed) : log.body
        lines.push(`--data-raw ${shellQuote(compact)}`)
    }
    return lines.join(' \\\n  ')
}

export type LogStatusTone = 'success' | 'warning' | 'error'

export function statusTone(log: RequestLogEntry): LogStatusTone {
    if (log.success) return 'success'
    if (log.status === 429 || (log.status !== undefined && log.status >= 400 && log.status < 500 && log.status !== 400)) {
        return 'warning'
    }
    return 'error'
}
