import { describe, expect, it } from 'vitest'

import { addOpenRouterAttribution, isOpenRouterUrl, withOpenRouterAttribution } from './openRouterHeaders'

describe('isOpenRouterUrl', () => {
    it('matches openrouter.ai and its subdomains', () => {
        expect(isOpenRouterUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(true)
        expect(isOpenRouterUrl('https://OpenRouter.ai/api/v1/responses')).toBe(true)
        expect(isOpenRouterUrl('https://eu.openrouter.ai/api/v1/chat/completions')).toBe(true)
    })

    it('rejects other hosts and invalid urls', () => {
        expect(isOpenRouterUrl('https://api.openai.com/v1/chat/completions')).toBe(false)
        expect(isOpenRouterUrl('https://notopenrouter.ai/api')).toBe(false)
        expect(isOpenRouterUrl('https://example.com/?u=https://openrouter.ai')).toBe(false)
        expect(isOpenRouterUrl('not a url')).toBe(false)
    })
})

describe('addOpenRouterAttribution', () => {
    it('adds referer and title headers', () => {
        expect(addOpenRouterAttribution({ Authorization: 'Bearer k' })).toEqual({
            Authorization: 'Bearer k',
            'HTTP-Referer': 'https://risuai.xyz',
            'X-Title': 'RisuAI',
        })
    })

    it('keeps headers the caller already set, case-insensitively', () => {
        expect(addOpenRouterAttribution({ 'http-referer': 'https://plugin.example', 'X-OpenRouter-Title': 'Plugin' })).toEqual({
            'http-referer': 'https://plugin.example',
            'X-OpenRouter-Title': 'Plugin',
        })
    })
})

describe('withOpenRouterAttribution', () => {
    it('returns a copy with attribution for OpenRouter requests', () => {
        const headers = { Authorization: 'Bearer k' }
        const arg = { method: 'POST', headers }
        const result = withOpenRouterAttribution('https://openrouter.ai/api/v1/chat/completions', arg)
        expect(result).toEqual({
            method: 'POST',
            headers: { Authorization: 'Bearer k', 'HTTP-Referer': 'https://risuai.xyz', 'X-Title': 'RisuAI' },
        })
        expect(headers).toEqual({ Authorization: 'Bearer k' })
    })

    it('handles missing options', () => {
        expect(withOpenRouterAttribution('https://openrouter.ai/api/v1/models')).toEqual({
            headers: { 'HTTP-Referer': 'https://risuai.xyz', 'X-Title': 'RisuAI' },
        })
    })

    it('keeps non-string header values such as secret header references', () => {
        const secret = { secretHeader: 'Authorization' }
        const result = withOpenRouterAttribution('https://openrouter.ai/api/v1/chat/completions', { headers: { Authorization: secret } })
        expect(result?.headers).toMatchObject({ Authorization: secret })
    })

    it('passes other requests through untouched', () => {
        const arg = { headers: { Authorization: 'Bearer k' } }
        expect(withOpenRouterAttribution('https://api.openai.com/v1/chat/completions', arg)).toBe(arg)
        expect(withOpenRouterAttribution('https://api.openai.com/v1/chat/completions')).toBeUndefined()
    })
})
