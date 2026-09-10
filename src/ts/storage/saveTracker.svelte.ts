import { untrack } from 'svelte'
import type { Database } from './database.svelte'
import type { toSaveType } from './risuSave'

const blocks = {
    botPresets: 'botPreset',
    modules: 'modules',
    loadouts: 'loadouts',
    plugins: 'plugins',
    pluginCustomStorage: 'pluginCustomStorage',
} as const

export type SaveTarget =
    | ['root', field: string]
    | ['character', characterId: string, section: string]
    | ['chat', characterId: string, chatId: string, section: string]
    | [(typeof blocks)[keyof typeof blocks]]

// Sections are the persisted fields of a character/chat (e.g. triggerscript,
// globalLore, message, hypaV3Data). Targets contain identifiers, never data.
// Read reactive dependencies without copying values or retaining old snapshots.
function readDeep(value: unknown, seen = new WeakSet<object>()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return
    // Match $state's deep-reactive objects; class instances are tracked on replacement.
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return
    seen.add(value)
    if (Array.isArray(value)) value.length // Length-only edits must also invalidate the section.
    for (const key of Object.keys(value)) readDeep(value[key], seen)
}

// Keep observers attached to objects when arrays are reordered. Removed objects
// are disposed immediately, including their nested chat observers.
function watchItems<T>(read: () => Iterable<T>, observe: (item: T) => void | (() => void)) {
    const watchers = new Map<T, () => void>()
    return $effect.root(() => {
        $effect(() => {
            const items = new Set(read())
            untrack(() => {
                for (const [item, stop] of watchers) {
                    if (!items.has(item)) {
                        stop()
                        watchers.delete(item)
                    }
                }
                for (const item of items) {
                    if (!watchers.has(item)) {
                        watchers.set(
                            item,
                            $effect.root(() => observe(item)),
                        )
                    }
                }
            })
        })
        return () => {
            for (const stop of watchers.values()) stop()
            watchers.clear()
        }
    })
}

// Initial registration conservatively marks all observed sections dirty.
export function createSaveTracker(read: () => Database, onChange: () => void) {
    const pending = new Map<string, SaveTarget>()
    let disposed = false

    function mark(target: SaveTarget) {
        if (disposed) return
        // A fresh tuple is also the revision token. Repeated edits replace it.
        pending.set(JSON.stringify(target), target)
        untrack(onChange)
    }

    function watchFields(object: () => object, target: (key: string) => SaveTarget | null, exclude: string[] = []) {
        return watchItems(
            () => Object.keys(object()).filter(key => !exclude.includes(key)),
            key => {
                $effect(() => {
                    readDeep(object()[key])
                    const changed = target(key)
                    if (changed) mark(changed)
                    // Also mark the old owner/section when IDs change or fields disappear.
                    return () => {
                        if (changed) mark([...changed] as SaveTarget)
                    }
                })
            },
        )
    }

    const stop = $effect.root(() => {
        const stopRoot = watchFields(read, key => ['root', key], ['characters', ...Object.keys(blocks)])
        for (const [key, block] of Object.entries(blocks)) {
            $effect(() => {
                readDeep(read()[key])
                mark([block])
            })
        }

        const stopCharacters = watchItems(
            () => read().characters ?? [],
            character => {
                const stopFields = watchFields(
                    () => character,
                    key => (character.chaId ? ['character', character.chaId, key] : null),
                    ['chats'],
                )
                $effect(() => {
                    Array.from(character.chats ?? [])
                    if (character.chaId) mark(['character', character.chaId, 'chats'])
                })
                const stopChats = watchItems(
                    () => character.chats ?? [],
                    chat =>
                        watchFields(
                            () => chat,
                            key => {
                                if (!character.chaId) return null
                                return chat.id
                                    ? ['chat', character.chaId, chat.id, key]
                                    : ['character', character.chaId, 'chats']
                            },
                        ),
                )
                return () => {
                    stopFields()
                    stopChats()
                }
            },
        )

        $effect(() => {
            Array.from(read().characters ?? [])
            mark(['root', 'characters'])
        })

        return () => {
            stopRoot()
            stopCharacters()
        }
    })

    return {
        // Reading a batch does not clear anything. A failed write can retry it.
        takeBatch() {
            const batch = new Map(pending)
            const toSave: toSaveType = {
                character: [],
                chat: [],
                botPreset: false,
                modules: false,
                loadouts: false,
                plugins: false,
                pluginCustomStorage: false,
            }
            const characters = new Set<string>()
            const chats = new Map<string, [string, string]>()
            for (const target of batch.values()) {
                switch (target[0]) {
                    case 'root':
                        break // The encoder always writes the root.
                    case 'character':
                        characters.add(target[1])
                        break
                    case 'chat':
                        characters.add(target[1])
                        chats.set(JSON.stringify(target.slice(1, 3)), [target[1], target[2]])
                        break
                    default:
                        toSave[target[0]] = true
                }
            }
            toSave.character = [...characters]
            toSave.chat = [...chats.values()]
            return {
                toSave,
                targets: Array.from(batch.values(), target => [...target] as SaveTarget),
                acknowledge() {
                    for (const [key, target] of batch) {
                        // Never clear edits made while this batch was being saved.
                        if (pending.get(key) === target) pending.delete(key)
                    }
                },
            }
        },
        dispose() {
            disposed = true
            stop()
            pending.clear()
        },
    }
}
