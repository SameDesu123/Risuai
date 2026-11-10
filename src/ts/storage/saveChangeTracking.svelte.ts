import { untrack } from "svelte"
import type { toSaveType } from "./risuSave"

/**
 * Own string keys of a $state proxy. Unlike for...in / Object.keys, this does not read the value
 * signal of every key (the proxy's getOwnPropertyDescriptor trap does), so only key additions and
 * removals are tracked.
 */
function ownKeys(obj: any): string[] {
    if (!obj || typeof obj !== 'object') {
        return []
    }
    return Reflect.ownKeys(obj).filter((key): key is string => typeof key === 'string')
}

type SaveChangeRegistration = {
    tracker: toSaveType
    onChange: () => void
}

/** the tracker of the running save loop (null before registerSaveChangeTracking and after its effect root is destroyed) */
let registration: SaveChangeRegistration | null = null

/**
 * Marks the data of a character dirty, but none of its chats (e.g. a character that is not selected was moved
 * to or restored from the trash), and schedules a save. The chaId is appended to `tracker.characterOnly`, so
 * `tracker.character[0]` / `tracker.chat[0]` (the current character and chat) are left alone.
 * Does nothing before the save loop registered its tracker.
 */
export function markCharacterChanged(chaId: string) {
    if (!registration || typeof chaId !== 'string') {
        return
    }
    const { tracker, onChange } = registration
    tracker.characterOnly ??= []
    if (!tracker.characterOnly.includes(chaId)) {
        tracker.characterOnly.push(chaId)
    }
    onChange()
}

/** Schedules a save without marking anything dirty (e.g. after deleting a character). Does nothing before registration. */
export function requestSave() {
    registration?.onChange()
}

/**
 * Resets the tracker after saveDb took a copy of it for a save attempt. The current character and the current
 * chat (index 0) stay dirty, so they are always re-encoded. loadouts, plugins and pluginCustomStorage are not
 * reset (as before).
 */
export function clearTakenDirty(tracker: toSaveType) {
    tracker.character = tracker.character.length === 0 ? [] : [tracker.character[0]]
    tracker.chat = tracker.chat.length === 0 ? [] : [tracker.chat[0]]
    tracker.allChats = []
    tracker.characterOnly = []
    tracker.botPreset = false
    tracker.modules = false
}

/** puts the dirty state of a save attempt that did not complete back into the tracker (appends, index 0 is kept) */
export function mergePendingDirty(tracker: toSaveType, pending: toSaveType) {
    for (const chaId of pending.character) {
        if (!tracker.character.includes(chaId)) {
            tracker.character.push(chaId)
        }
    }
    for (const [chaId, chatId] of pending.chat) {
        if (!tracker.chat.some((v) => v[0] === chaId && v[1] === chatId)) {
            tracker.chat.push([chaId, chatId])
        }
    }
    tracker.allChats ??= []
    for (const chaId of pending.allChats ?? []) {
        if (!tracker.allChats.includes(chaId)) {
            tracker.allChats.push(chaId)
        }
    }
    tracker.characterOnly ??= []
    for (const chaId of pending.characterOnly ?? []) {
        if (!tracker.characterOnly.includes(chaId)) {
            tracker.characterOnly.push(chaId)
        }
    }
    tracker.botPreset ||= pending.botPreset
    tracker.modules ||= pending.modules
    tracker.loadouts ||= pending.loadouts
    tracker.plugins ||= pending.plugins
    tracker.pluginCustomStorage ||= pending.pluginCustomStorage
}

/**
 * Registers the effects that mark the root settings and the selected character dirty for saveDb.
 * Must be called inside an effect root.
 *
 * The parts are tracked by separate effects, so that a streaming update of the current chat
 * only re-runs the current chat effect (d):
 * (a) root-level keys
 * (b) the selected character, except its chats (and reloadKeys, which is bumped on every streaming chunk)
 * (c) the chats array of the selected character and every chat except the current one: marks all chats dirty
 * (d) the current chat and reloadKeys: marks only the current chat dirty
 * Every effect marks the selected character dirty and calls onChange, as the single effect did before.
 * When the selection changes to no character, (b) still calls onChange (only (b), so a deselect
 * schedules one save, not three), as the single effect did.
 *
 * Changes the effects cannot see (a character that is not selected) are reported with
 * markCharacterChanged / requestSave. Deleted characters need no marking: the encoder drops the blocks
 * of every character that is no longer in the database, it only needs a save to be scheduled.
 */
export function registerSaveChangeTracking(arg: {
    tracker: toSaveType
    getDb: () => any
    getSelectedIndex: () => number
    onChange: () => void
}) {
    const { tracker, getDb, getSelectedIndex, onChange } = arg
    tracker.allChats ??= []
    tracker.characterOnly ??= []

    const current: SaveChangeRegistration = { tracker, onChange }
    registration = current
    // no dependencies: only runs again when the effect root is destroyed
    $effect(() => {
        return () => {
            if (registration === current) {
                registration = null
            }
        }
    })

    function markCharacterDirty(chaId: string) {
        if (tracker.character[0] !== chaId) {
            tracker.character.unshift(chaId)
        }
    }
    function markChatDirty(chaId: string, chatId: string) {
        if (tracker.chat[0]?.[0] !== chaId || tracker.chat[0]?.[1] !== chatId) {
            tracker.chat.unshift([chaId, chatId])
        }
    }
    function markAllChatsDirty(chaId: string) {
        if (!tracker.allChats.includes(chaId)) {
            tracker.allChats.push(chaId)
        }
    }

    // (a) root-level keys
    $effect(() => {
        const db = getDb()
        for (const key of ownKeys(db)) {
            if (
                key !== 'characters' && key !== 'botPresets' && key !== 'modules' &&
                key !== 'loadouts' && key !== 'plugins' && key !== 'pluginCustomStorage'
            ) {
                $state.snapshot(db[key])
            }
        }
        untrack(() => {
            const character = getDb()?.characters?.[getSelectedIndex()]
            if (character) {
                markCharacterDirty(character.chaId)
            }
        })
        onChange()
    })
    // (b) selected character, everything except its chats and reloadKeys
    $effect(() => {
        const character = getDb()?.characters?.[getSelectedIndex()]
        if (!character) {
            // Nothing to mark dirty, but the selection changed to no character: still schedule a save
            onChange()
            return
        }
        for (const key of ownKeys(character)) {
            if (key !== 'chats' && key !== 'reloadKeys') {
                $state.snapshot(character[key])
            }
        }
        untrack(() => {
            markCharacterDirty(character.chaId)
        })
        onChange()
    })
    // (c) the chats array of the selected character and every chat except the current one
    $effect(() => {
        const character = getDb()?.characters?.[getSelectedIndex()]
        if (!character) {
            return
        }
        const chats = character.chats
        const chatPage = character.chatPage
        if (Array.isArray(chats)) {
            const length = chats.length
            for (let i = 0; i < length; i++) {
                if (i !== chatPage) {
                    $state.snapshot(chats[i])
                }
            }
        }
        else {
            $state.snapshot(chats)
        }
        untrack(() => {
            markCharacterDirty(character.chaId)
            markAllChatsDirty(character.chaId)
        })
        onChange()
    })
    // (d) the current chat
    $effect(() => {
        const character = getDb()?.characters?.[getSelectedIndex()]
        if (!character) {
            return
        }
        character.reloadKeys
        const currentChat = character.chats?.[character.chatPage]
        $state.snapshot(currentChat)
        untrack(() => {
            markCharacterDirty(character.chaId)
            if (currentChat) {
                markChatDirty(character.chaId, currentChat.id)
            }
        })
        onChange()
    })
}
