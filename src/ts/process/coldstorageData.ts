import { safeStructuredClone } from "../polyfill"
import type { Chat, Database, character, groupChat } from "../storage/database.svelte"

export const coldStorageHeader = '\uEF01COLDSTORAGE\uEF01'

export function getColdStorageBackupKey(name: string): string | null {
    const match = name.match(/^(?:coldstorage[/_])?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.json$/)
    return match?.[1] ?? null
}

export function getColdStorageBackupName(key: string): string {
    return `coldstorage_${key}.json`
}

export function isColdStorageBackupData(data: unknown): boolean {
    if (Array.isArray(data)) {
        return true
    }

    return !!data
        && typeof data === 'object'
        && ('character' in data || 'message' in data)
}

/**
 * pluginStorage values can be any JSON value (including primitives and null), unlike character/chat cold data.
 */
export function isValidColdStorageItem(data: unknown, isPluginStorage: boolean): boolean {
    if (isPluginStorage) {
        return data !== undefined
    }
    return isColdStorageBackupData(data)
}

/**
 * Cold storage ids of the legacy per-key plugin storage layout (db.pluginCustomStorage._coldplugin values).
 * These are migrated into the plugin storage index on load.
 */
export function listPluginStorageColdKeys(db: Pick<Database, 'pluginCustomStorage'> | null | undefined): string[] {
    const coldPlugin = db?.pluginCustomStorage?._coldplugin
    if (!coldPlugin || typeof coldPlugin !== 'object') {
        return []
    }
    return Object.values(coldPlugin).filter((key): key is string => typeof key === 'string')
}

function replaceData(data: string | undefined, replacer: { [key: string]: string }) {
    if (!data) {
        return data
    }
    return replacer[data] ?? data
}

function replaceCharacterResources(cha: character | groupChat, replacer: { [key: string]: string }) {
    cha.image = replaceData(cha.image, replacer)

    if (cha.emotionImages) {
        for (let i = 0; i < cha.emotionImages.length; i++) {
            cha.emotionImages[i][1] = replaceData(cha.emotionImages[i][1], replacer)
        }
    }

    if (cha.type !== 'group' && cha.additionalAssets) {
        for (let i = 0; i < cha.additionalAssets.length; i++) {
            cha.additionalAssets[i][1] = replaceData(cha.additionalAssets[i][1], replacer)
        }
    }
}

export function replaceColdStoragePayloadResources(data: unknown, replacer: { [key: string]: string }): unknown {
    if (
        !data
        || typeof data !== 'object'
        || !('character' in data)
        || !data.character
        || typeof data.character !== 'object'
    ) {
        return data
    }

    const cloned = safeStructuredClone(data) as { character: character | groupChat }
    replaceCharacterResources(cloned.character, replacer)
    return cloned
}

function listColdDataKeysFromCharacter(character: character | groupChat): string[] {
    const keys: string[] = []
    if (character.coldstorage) {
        keys.push(character.coldstorage)
        keys.push(...(character.coldStoragedChats ?? []))
    }
    for (const chat of character.chats ?? []) {
        const firstMessage = chat.message?.[0]
        if (firstMessage?.data?.startsWith(coldStorageHeader)) {
            keys.push(firstMessage.data.slice(coldStorageHeader.length))
        }
    }
    return keys
}

export function getPluginStorageIndexPointer(db: Pick<Database, 'pluginCustomStorage'> | null | undefined): string | null {
    const pointer = db?.pluginCustomStorage?._coldpluginIndex
    return typeof pointer === 'string' ? pointer : null
}

export function listColdDataKeysFromDb(db: Pick<Database, 'characters'|'pluginCustomStorage'> | null | undefined): string[] {
    const keys = new Set<string>()
    for (const character of db?.characters ?? []) {
        if (!character) {
            continue
        }
        for (const key of listColdDataKeysFromCharacter(character)) {
            keys.add(key)
        }
    }

    for(const key of listPluginStorageColdKeys(db)){
        keys.add(key)
    }

    //plugin storage index item; the large values it references are listed by listColdDataKeys (async)
    const pluginStorageIndex = getPluginStorageIndexPointer(db)
    if(pluginStorageIndex){
        keys.add(pluginStorageIndex)
    }

    return Array.from(keys)
}

export function getColdStorageAffectedCharacters(
    db: Pick<Database, 'characters'> | null | undefined,
    unavailableKeys: Iterable<string>,
): {
    characterNames: string[]
    unresolvedKeys: string[]
} {
    const targetKeys = new Set(unavailableKeys)
    const resolvedKeys = new Set<string>()
    const characterNames: string[] = []

    for (const character of db?.characters ?? []) {
        if (!character) {
            continue
        }

        let isAffected = false
        for (const key of listColdDataKeysFromCharacter(character)) {
            if (targetKeys.has(key)) {
                resolvedKeys.add(key)
                isAffected = true
            }
        }

        if (isAffected) {
            characterNames.push(character.name?.trim() || character.chaId || 'Unknown character')
        }
    }

    return {
        characterNames,
        unresolvedKeys: Array.from(targetKeys).filter((key) => !resolvedKeys.has(key)),
    }
}

export function getColdChatKey(chat: Pick<Chat, 'message'> | null | undefined): string | null {
    const data = chat?.message?.[0]?.data
    if (typeof data !== 'string' || !data.startsWith(coldStorageHeader)) {
        return null
    }
    return data.slice(coldStorageHeader.length)
}

/**
 * Returns a copy of a cold chat with its cold storage payload merged in, without touching the original.
 * Handles the same payload shapes as preLoadChat (legacy message array, or the object form).
 * Returns null if the payload is missing or invalid.
 */
export function mergeColdChatData<T extends Chat>(chat: T, coldData: unknown): T | null {
    if (Array.isArray(coldData)) {
        return { ...chat, message: coldData }
    }
    if (coldData && typeof coldData === 'object' && Array.isArray((coldData as any).message)) {
        const data = coldData as Pick<Chat, 'message' | 'hypaV2Data' | 'hypaV3Data' | 'scriptstate' | 'localLore'>
        return {
            ...chat,
            message: data.message,
            hypaV2Data: data.hypaV2Data,
            hypaV3Data: data.hypaV3Data,
            scriptstate: data.scriptstate,
            localLore: data.localLore,
        }
    }
    return null
}
