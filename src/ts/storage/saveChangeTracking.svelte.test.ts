import { flushSync } from 'svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { toSaveType } from './risuSave'
import { clearTakenDirty, markCharacterChanged, mergePendingDirty, registerSaveChangeTracking, requestSave } from './saveChangeTracking.svelte'

function makeChat(id: string, count: number): Record<string, any> {
    return {
        id,
        name: id,
        note: '',
        localLore: [],
        message: Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'char' : 'user', data: `${id} ${i}` })),
    }
}

function makeDb() {
    return {
        username: 'tester',
        theme: 'dark',
        botPresets: [],
        modules: [],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: {},
        characters: [
            {
                chaId: 'cha-a',
                name: 'A',
                reloadKeys: 0,
                chatPage: 1,
                chats: [makeChat('a1', 3), makeChat('a2', 3), makeChat('a3', 3)],
            },
            {
                chaId: 'cha-b',
                name: 'B',
                reloadKeys: 0,
                chatPage: 0,
                chats: [makeChat('b1', 2)],
            },
        ],
    }
}

describe('registerSaveChangeTracking', () => {
    let state: { db: ReturnType<typeof makeDb>, selected: number }
    let tracker: toSaveType
    let runs = 0
    let cleanup: () => void

    function resetTracker() {
        tracker.character.length = 0
        tracker.chat.length = 0
        tracker.allChats.length = 0
        tracker.characterOnly.length = 0
        runs = 0
    }

    beforeEach(() => {
        const fresh = $state({ db: makeDb(), selected: 0 })
        state = fresh
        tracker = {
            character: [],
            chat: [],
            allChats: [],
            characterOnly: [],
            botPreset: false,
            modules: false,
            loadouts: false,
            plugins: false,
            pluginCustomStorage: false,
        }
        runs = 0
        cleanup = $effect.root(() => {
            registerSaveChangeTracking({
                tracker,
                getDb: () => state.db,
                getSelectedIndex: () => state.selected,
                onChange: () => {
                    runs++
                },
            })
        })
        flushSync()
    })

    afterEach(() => {
        cleanup()
    })

    it('marks the selected character, its current chat and all its chats on start', () => {
        expect(runs).toBe(4)
        expect(tracker.character).toEqual(['cha-a'])
        expect(tracker.chat).toEqual([['cha-a', 'a2']])
        expect(tracker.allChats).toEqual(['cha-a'])
    })

    it('a streaming update of the current chat only re-runs the current chat effect', () => {
        resetTracker()
        const chat = state.db.characters[0].chats[1]
        chat.message[chat.message.length - 1].data += ' more'
        state.db.characters[0].reloadKeys += 1
        flushSync()
        expect(runs).toBe(1)
        expect(tracker.character).toEqual(['cha-a'])
        expect(tracker.chat).toEqual([['cha-a', 'a2']])
        expect(tracker.allChats).toEqual([])

        resetTracker()
        chat.message.push({ role: 'char', data: 'new message' })
        state.db.characters[0].chats[1].isStreaming = true
        flushSync()
        expect(runs).toBe(1)
        expect(tracker.allChats).toEqual([])
    })

    it('a change in another chat marks all chats dirty', () => {
        resetTracker()
        state.db.characters[0].chats[2].message[0].data = 'edited'
        flushSync()
        expect(runs).toBe(1)
        expect(tracker.character).toEqual(['cha-a'])
        expect(tracker.chat).toEqual([])
        expect(tracker.allChats).toEqual(['cha-a'])
    })

    it('adding or removing chats marks all chats dirty', () => {
        resetTracker()
        state.db.characters[0].chats.push(makeChat('a4', 1))
        flushSync()
        expect(tracker.allChats).toEqual(['cha-a'])

        resetTracker()
        state.db.characters[0].chats.splice(0, 1)
        flushSync()
        expect(tracker.allChats).toEqual(['cha-a'])
    })

    it('a root setting change marks the selected character without chats', () => {
        resetTracker()
        state.db.theme = 'light'
        flushSync()
        expect(runs).toBe(1)
        expect(tracker.character).toEqual(['cha-a'])
        expect(tracker.chat).toEqual([])
        expect(tracker.allChats).toEqual([])
    })

    it('a character field change does not touch the chat effects', () => {
        resetTracker()
        state.db.characters[0].name = 'A2'
        flushSync()
        expect(runs).toBe(1)
        expect(tracker.character).toEqual(['cha-a'])
        expect(tracker.chat).toEqual([])
        expect(tracker.allChats).toEqual([])
    })

    it('changing the chat page marks the new current chat', () => {
        resetTracker()
        state.db.characters[0].chatPage = 2
        flushSync()
        expect(tracker.character).toEqual(['cha-a'])
        expect(tracker.chat).toEqual([['cha-a', 'a3']])
        expect(tracker.allChats).toEqual(['cha-a'])
    })

    it('changing the selected character tracks the new one', () => {
        resetTracker()
        state.selected = 1
        flushSync()
        expect(tracker.character).toEqual(['cha-b'])
        expect(tracker.chat).toEqual([['cha-b', 'b1']])
        expect(tracker.allChats).toEqual(['cha-b'])

        resetTracker()
        state.db.characters[0].chats[0].message[0].data = 'not selected anymore'
        flushSync()
        expect(runs).toBe(0)
    })

    it('deselecting the character schedules a save without marking anything dirty', () => {
        resetTracker()
        state.selected = -1
        flushSync()
        expect(runs).toBe(1)
        expect(tracker.character).toEqual([])
        expect(tracker.chat).toEqual([])
        expect(tracker.allChats).toEqual([])
    })

    it('deleting a non-selected character and then deselecting schedules a save', () => {
        state.selected = 1
        flushSync()
        resetTracker()
        state.db.characters.splice(0, 1)
        state.selected = -1
        flushSync()
        expect(runs).toBeGreaterThan(0)
    })

    it('does nothing for the character effects when no character is selected', () => {
        state.selected = -1
        flushSync()
        resetTracker()
        state.db.theme = 'light'
        flushSync()
        expect(runs).toBe(1)
        expect(tracker.character).toEqual([])
        state.db.characters[0].name = 'A2'
        state.db.characters[0].chats[1].message[0].data = 'edited'
        flushSync()
        expect(runs).toBe(1)
        expect(tracker.character).toEqual([])
        expect(tracker.chat).toEqual([])
        expect(tracker.allChats).toEqual([])
    })

    it('markCharacterChanged appends a character-only entry without displacing the current character', () => {
        resetTracker()
        state.db.characters[0].name = 'A2'
        flushSync()
        runs = 0
        markCharacterChanged('cha-b')
        expect(runs).toBe(1)
        expect(tracker.character).toEqual(['cha-a'])
        expect(tracker.chat).toEqual([])
        expect(tracker.allChats).toEqual([])
        expect(tracker.characterOnly).toEqual(['cha-b'])

        markCharacterChanged('cha-b')
        markCharacterChanged('cha-a')
        expect(runs).toBe(3)
        expect(tracker.characterOnly).toEqual(['cha-b', 'cha-a'])
        expect(tracker.character[0]).toBe('cha-a')
    })

    it('markCharacterChanged does not trigger the save effects', () => {
        resetTracker()
        state.db.characters[1].name = 'B in trash'
        markCharacterChanged('cha-b')
        flushSync()
        //the non-selected character is not tracked by the effects: only the explicit call schedules a save
        expect(runs).toBe(1)
        expect(tracker.character).toEqual([])
    })

    it('requestSave schedules a save without marking anything', () => {
        state.selected = -1
        flushSync()
        resetTracker()
        requestSave()
        expect(runs).toBe(1)
        expect(tracker.character).toEqual([])
        expect(tracker.characterOnly).toEqual([])
    })

    it('deleting a character with nothing selected is not seen by the effects (removeChar calls requestSave)', () => {
        state.selected = -1
        flushSync()
        resetTracker()
        //a trashed character is not in characterOrder, so removeChar changes no root key either
        state.db.characters.splice(1, 1)
        state.selected = -1
        flushSync()
        expect(runs).toBe(0)
        requestSave()
        expect(runs).toBe(1)
    })

    it('is harmless before registration and after the effect root is destroyed', () => {
        cleanup()
        resetTracker()
        expect(() => markCharacterChanged('cha-b')).not.toThrow()
        expect(() => requestSave()).not.toThrow()
        expect(runs).toBe(0)
        expect(tracker.characterOnly).toEqual([])
        //afterEach calls cleanup again
        cleanup = () => {}
    })
})

describe('saveDb tracker helpers', () => {
    function makeTracker(extra: Partial<toSaveType> = {}): toSaveType {
        return {
            character: [],
            chat: [],
            allChats: [],
            characterOnly: [],
            botPreset: false,
            modules: false,
            loadouts: false,
            plugins: false,
            pluginCustomStorage: false,
            ...extra,
        }
    }

    it('clearTakenDirty keeps index 0 and clears the character-only entries', () => {
        const tracker = makeTracker({
            character: ['cur', 'other'],
            chat: [['cur', 'c1'], ['other', 'o1']],
            allChats: ['cur'],
            characterOnly: ['trashed'],
            botPreset: true,
            modules: true,
        })
        clearTakenDirty(tracker)
        expect(tracker.character).toEqual(['cur'])
        expect(tracker.chat).toEqual([['cur', 'c1']])
        expect(tracker.allChats).toEqual([])
        expect(tracker.characterOnly).toEqual([])
        expect(tracker.botPreset).toBe(false)
        expect(tracker.modules).toBe(false)
    })

    it('mergePendingDirty puts a failed attempt back by appending, without duplicates', () => {
        const pending = makeTracker({
            character: ['cur', 'other'],
            chat: [['cur', 'c1']],
            allChats: ['other'],
            characterOnly: ['trashed', 'restored'],
            modules: true,
        })
        const tracker = makeTracker({ character: ['new-cur'], chat: [['new-cur', 'n1']], characterOnly: ['restored'] })
        mergePendingDirty(tracker, pending)
        expect(tracker.character).toEqual(['new-cur', 'cur', 'other'])
        expect(tracker.chat).toEqual([['new-cur', 'n1'], ['cur', 'c1']])
        expect(tracker.allChats).toEqual(['other'])
        expect(tracker.characterOnly).toEqual(['restored', 'trashed'])
        expect(tracker.modules).toBe(true)
    })

    it('mergePendingDirty accepts trackers without the optional fields', () => {
        const tracker = makeTracker()
        delete tracker.characterOnly
        delete tracker.allChats
        mergePendingDirty(tracker, makeTracker({ characterOnly: ['x'], allChats: ['y'] }))
        expect(tracker.characterOnly).toEqual(['x'])
        expect(tracker.allChats).toEqual(['y'])
    })
})
