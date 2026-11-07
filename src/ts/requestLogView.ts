/**
 * Helpers that turn raw fetch log entries into something easy to inspect
 * in the request log viewer (model name, prompt messages, token usage,
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

export type RequestLogTab = 'messages' | 'body' | 'header' | 'response'

export interface LogMessage {
    role: string
    text: string
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
    messages: LogMessage[] | null
    usage: LogUsage | null
    errorMessage: string | null
    outputText: string | null
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

function partToText(part: any): string {
    if (part === null || part === undefined) {
        return ''
    }
    if (typeof part === 'string') {
        return part
    }
    if (typeof part !== 'object') {
        return String(part)
    }
    if (typeof part.text === 'string') {
        return part.text
    }
    if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') {
        return '[image]'
    }
    if (part.type === 'input_audio' || part.type === 'audio') {
        return '[audio]'
    }
    if (part.inlineData || part.inline_data) {
        const d = part.inlineData ?? part.inline_data
        return `[inline data: ${d?.mimeType ?? d?.mime_type ?? 'unknown'}]`
    }
    if (part.fileData || part.file_data) {
        return '[file]'
    }
    if (part.type === 'tool_use' || part.functionCall) {
        const name = part.name ?? part.functionCall?.name ?? ''
        const args = part.input ?? part.functionCall?.args ?? {}
        return `[tool call: ${name}] ${JSON.stringify(args)}`
    }
    if (part.type === 'tool_result' || part.functionResponse) {
        const inner = part.content ?? part.functionResponse?.response
        return `[tool result] ${typeof inner === 'string' ? inner : contentToText(inner)}`
    }
    if (part.type === 'thinking' && typeof part.thinking === 'string') {
        return `[thinking] ${part.thinking}`
    }
    return JSON.stringify(part)
}

function contentToText(content: any): string {
    if (Array.isArray(content)) {
        return content.map(partToText).filter((t) => t !== '').join('\n')
    }
    if (content && typeof content === 'object' && Array.isArray(content.parts)) {
        return contentToText(content.parts)
    }
    return partToText(content)
}

/**
 * Extracts the prompt as a flat list of messages from the common
 * request formats (OpenAI chat, OpenAI responses, Anthropic, Google).
 */
export function extractMessages(body: any): LogMessage[] | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return null
    }
    const result: LogMessage[] = []

    // Anthropic / Google / OpenAI responses system prompts
    if (body.system !== undefined) {
        const text = contentToText(body.system)
        if (text) result.push({ role: 'system', text })
    }
    const sys = body.systemInstruction ?? body.system_instruction
    if (sys) {
        const text = contentToText(sys)
        if (text) result.push({ role: 'system', text })
    }
    if (typeof body.instructions === 'string' && body.instructions) {
        result.push({ role: 'system', text: body.instructions })
    }

    const list = Array.isArray(body.messages) ? body.messages
        : Array.isArray(body.contents) ? body.contents
        : Array.isArray(body.input) ? body.input
        : null

    if (list) {
        for (const msg of list) {
            if (!msg || typeof msg !== 'object') {
                result.push({ role: 'unknown', text: partToText(msg) })
                continue
            }
            const role = msg.role ?? msg.type ?? 'unknown'
            const content = msg.content ?? msg.parts ?? msg.output ?? msg.arguments ?? ''
            let text = contentToText(content)
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                const calls = msg.tool_calls.map((c: any) =>
                    `[tool call: ${c?.function?.name ?? ''}] ${c?.function?.arguments ?? ''}`
                ).join('\n')
                text = text ? `${text}\n${calls}` : calls
            }
            result.push({ role: String(role), text })
        }
    } else if (typeof body.input === 'string') {
        result.push({ role: 'user', text: body.input })
    } else if (typeof body.prompt === 'string') {
        result.push({ role: 'prompt', text: body.prompt })
    }

    return result.length > 0 ? result : null
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

export function extractOutputText(response: any): string | null {
    if (!response || typeof response !== 'object') {
        return null
    }
    // OpenAI chat
    const choice = response.choices?.[0]
    if (choice) {
        const c = choice.message?.content ?? choice.text
        if (typeof c === 'string') return c
        if (Array.isArray(c)) return contentToText(c)
    }
    // Anthropic
    if (Array.isArray(response.content) && response.type === 'message') {
        return contentToText(response.content.filter((p: any) => p?.type !== 'thinking'))
    }
    // Google
    const cand = response.candidates?.[0]?.content?.parts
    if (Array.isArray(cand)) {
        return contentToText(cand.filter((p: any) => !p?.thought))
    }
    // OpenAI responses
    if (typeof response.output_text === 'string') {
        return response.output_text
    }
    if (Array.isArray(response.output)) {
        const msgs = response.output.filter((o: any) => o?.type === 'message')
        if (msgs.length > 0) {
            return msgs.map((m: any) => contentToText(m.content)).join('\n')
        }
    }
    return null
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
        messages: extractMessages(body),
        usage: extractUsage(response),
        errorMessage: log.success ? null : extractErrorMessage(response, log.response),
        outputText: log.success ? extractOutputText(response) : null,
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
