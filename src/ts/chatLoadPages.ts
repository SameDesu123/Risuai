export const DEFAULT_CHAT_LOAD_INITIAL_PAGES = 30
export const DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES = 15

export function normalizeChatLoadPages(value: unknown, fallback: number): number {
    const fallbackValue = Number.isFinite(fallback) && fallback >= 1
        ? Math.floor(fallback)
        : 1
    const numberValue = typeof value === 'number' ? value : Number(value)

    if (!Number.isFinite(numberValue) || numberValue < 1) {
        return fallbackValue
    }

    return Math.floor(numberValue)
}

/** messages rendered when a chat is opened in emergency mode */
export const EMERGENCY_CHAT_LOAD_INITIAL_PAGES = 5

export function getInitialChatLoadPages(db: { chatLoadInitialPages?: number }, emergencyMode = false): number {
    const pages = normalizeChatLoadPages(db.chatLoadInitialPages, DEFAULT_CHAT_LOAD_INITIAL_PAGES)
    return emergencyMode ? Math.min(pages, EMERGENCY_CHAT_LOAD_INITIAL_PAGES) : pages
}

export function getAdditionalChatLoadPages(db: { chatLoadAdditionalPages?: number }): number {
    return normalizeChatLoadPages(db.chatLoadAdditionalPages, DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES)
}
