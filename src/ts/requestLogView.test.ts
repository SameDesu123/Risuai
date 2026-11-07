import { describe, expect, it } from 'vitest'
import {
    buildCurl,
    extractMessages,
    extractModel,
    extractOutputText,
    extractUsage,
    maskHeaders,
    maskUrl,
    statusTone,
    summarizeLog,
    type RequestLogEntry,
} from './requestLogView'

function makeLog(partial: Partial<RequestLogEntry>): RequestLogEntry {
    return {
        body: '{}',
        header: '{}',
        response: '{}',
        success: true,
        date: '12:00:00',
        url: 'https://api.example.com/v1/chat/completions',
        ...partial,
    }
}

describe('requestLogView', () => {
    it('extracts OpenAI chat messages including tool calls', () => {
        const msgs = extractMessages({
            model: 'gpt-x',
            messages: [
                { role: 'system', content: 'be nice' },
                { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:' } }] },
                { role: 'assistant', content: null, tool_calls: [{ function: { name: 'search', arguments: '{"q":1}' } }] },
            ],
        })
        expect(msgs).toEqual([
            { role: 'system', text: 'be nice' },
            { role: 'user', text: 'hi\n[image]' },
            { role: 'assistant', text: '[tool call: search] {"q":1}' },
        ])
    })

    it('extracts Anthropic system and Google contents', () => {
        expect(extractMessages({
            system: [{ type: 'text', text: 'sys' }],
            messages: [{ role: 'user', content: 'hello' }],
        })).toEqual([
            { role: 'system', text: 'sys' },
            { role: 'user', text: 'hello' },
        ])
        expect(extractMessages({
            systemInstruction: { parts: [{ text: 'gsys' }] },
            contents: [{ role: 'model', parts: [{ text: 'a' }, { inlineData: { mimeType: 'image/png', data: 'x' } }] }],
        })).toEqual([
            { role: 'system', text: 'gsys' },
            { role: 'model', text: 'a\n[inline data: image/png]' },
        ])
    })

    it('returns null for non prompt bodies', () => {
        expect(extractMessages({ foo: 1 })).toBeNull()
        expect(extractMessages(undefined)).toBeNull()
    })

    it('finds model from body or Google style URL', () => {
        expect(extractModel({ model: 'claude-x' }, '')).toBe('claude-x')
        expect(extractModel(undefined, 'https://g.example.com/v1beta/models/gemini-pro:streamGenerateContent?key=abc')).toBe('gemini-pro')
        expect(extractModel(undefined, 'https://x.example.com/v1/chat')).toBeNull()
    })

    it('reads usage across providers', () => {
        expect(extractUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })).toEqual({ input: 10, output: 5, total: 15 })
        expect(extractUsage({ usage: { input_tokens: 3, output_tokens: 4 } })).toEqual({ input: 3, output: 4, total: 7 })
        expect(extractUsage({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } })).toEqual({ input: 1, output: 2, total: 3 })
        expect(extractUsage({})).toBeNull()
    })

    it('reads output text across providers', () => {
        expect(extractOutputText({ choices: [{ message: { content: 'hey' } }] })).toBe('hey')
        expect(extractOutputText({ type: 'message', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'yo' }] })).toBe('yo')
        expect(extractOutputText({ candidates: [{ content: { parts: [{ text: 't', thought: true }, { text: 'g' }] } }] })).toBe('g')
    })

    it('masks secrets in headers and URLs', () => {
        const masked = JSON.parse(maskHeaders(JSON.stringify({
            Authorization: 'Bearer sk-1234567890abcdef',
            'x-api-key': 'short',
            'Content-Type': 'application/json',
        })))
        expect(masked.Authorization).toBe('Bearer sk-1••••••••cdef')
        expect(masked['x-api-key']).toBe('••••••••')
        expect(masked['Content-Type']).toBe('application/json')
        expect(maskUrl('https://g.example.com/a?key=AIzaSecretValue99&alt=sse')).toBe('https://g.example.com/a?key=AIza••••••••ue99&alt=sse')
        expect(maskUrl('not a url')).toBe('not a url')
    })

    it('summarizes errors and builds masked curl', () => {
        const log = makeLog({
            success: false,
            status: 401,
            body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: "it's" }] }),
            header: JSON.stringify({ Authorization: 'Bearer sk-1234567890abcdef' }),
            response: JSON.stringify({ error: { message: 'Invalid key' } }),
        })
        const s = summarizeLog(log)
        expect(s.model).toBe('m')
        expect(s.errorMessage).toBe('Invalid key')
        expect(s.host).toBe('api.example.com')
        expect(statusTone(log)).toBe('warning')

        const curl = buildCurl(log, false)
        expect(curl).toContain("-H 'Authorization: Bearer sk-1••••••••cdef'")
        expect(curl).toContain(`'{"model":"m","messages":[{"role":"user","content":"it'\\''s"}]}'`)
        expect(buildCurl(log, true)).toContain('sk-1234567890abcdef')
    })

    it('handles double encoded JSON responses', () => {
        const log = makeLog({ response: JSON.stringify(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } })) })
        expect(summarizeLog(log).usage).toEqual({ input: 1, output: 1, total: 2 })
    })
})
