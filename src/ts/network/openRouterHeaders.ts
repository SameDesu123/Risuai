const openRouterHostname = 'openrouter.ai'

export function isOpenRouterUrl(url: string): boolean {
    try {
        const hostname = new URL(url).hostname.toLowerCase()
        return hostname === openRouterHostname || hostname.endsWith(`.${openRouterHostname}`)
    } catch {
        return false
    }
}

/**
 * Adds OpenRouter app attribution headers, keeping any the caller already set.
 */
export function addOpenRouterAttribution(headers: Record<string, string>): Record<string, string> {
    const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()))
    if (!names.has('http-referer')) {
        headers['HTTP-Referer'] = 'https://risuai.xyz'
    }
    if (!names.has('x-title') && !names.has('x-openrouter-title')) {
        headers['X-Title'] = 'RisuAI'
    }
    return headers
}

/**
 * Returns a copy of plugin fetch options with attribution headers added
 * when the request goes to OpenRouter. Other requests are passed through untouched.
 */
export function withOpenRouterAttribution<T extends { headers?: unknown }>(url: string, arg?: T): T | undefined {
    if (!isOpenRouterUrl(url)) {
        return arg
    }
    const headers = arg?.headers ?? {}
    if (typeof headers !== 'object' || Array.isArray(headers) || (typeof Headers !== 'undefined' && headers instanceof Headers)) {
        return arg
    }
    return { ...arg, headers: addOpenRouterAttribution({ ...(headers as Record<string, string>) }) } as T
}
