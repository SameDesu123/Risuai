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
    | ['root', string]
    | ['character', string]
    | ['chat', string, string]
    | [(typeof blocks)[keyof typeof blocks]]

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

export function createSaveTracker(read: () => Database, onChange: () => void) {
    const pending = new Map<string, SaveTarget>()
    let disposed = false

    function mark(target: SaveTarget) {
        if (disposed) return
        // A fresh tuple is also the revision token. Repeated edits replace it.
        pending.set(JSON.stringify(target), target)
        untrack(onChange)
    }

    const stop = $effect.root(() => {
        const stopRoot = watchItems(
            () => Object.keys(read()).filter(key => key !== 'characters' && !Object.hasOwn(blocks, key)),
            key => {
                $effect(() => {
                    $state.snapshot(read()[key])
                    mark(['root', key])
                })
                return () => mark(['root', key])
            },
        )

        for (const [key, block] of Object.entries(blocks)) {
            $effect(() => {
                $state.snapshot(read()[key])
                mark([block])
            })
        }

        const stopCharacters = watchItems(
            () => read().characters ?? [],
            character => {
                $effect(() => {
                    const id = character.chaId
                    for (const key in character) {
                        if (key !== 'chats') $state.snapshot(character[key])
                    }
                    if (id) mark(['character', id])
                    return () => {
                        if (id) mark(['character', id])
                    }
                })
                // Chat ordering/replacement is part of the persisted character too.
                $effect(() => {
                    Array.from(character.chats ?? [])
                    if (character.chaId) mark(['character', character.chaId])
                })
                return watchItems(
                    () => character.chats ?? [],
                    chat => {
                        $effect(() => {
                            const characterId = character.chaId
                            const chatId = chat.id
                            $state.snapshot(chat)
                            const changed = () => {
                                if (!characterId) return
                                mark(['character', characterId])
                                if (chatId) mark(['chat', characterId, chatId])
                            }
                            changed()
                            return changed
                        })
                    },
                )
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
        snapshot() {
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
            for (const target of batch.values()) {
                switch (target[0]) {
                    case 'root':
                        break // The encoder always writes the root.
                    case 'character':
                        toSave.character.push(target[1])
                        break
                    case 'chat':
                        toSave.chat.push([target[1], target[2]])
                        break
                    default:
                        toSave[target[0]] = true
                }
            }
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
