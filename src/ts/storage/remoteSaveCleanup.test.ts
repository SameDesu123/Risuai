import { describe, expect, it } from 'vitest'

import {
    getActiveRemotePayloadNames,
    getInactiveRemoteSaveAction,
    getRemoteChatPayloadName,
    getRemoteSaveCleanupAction,
    getRemoteSavePayloadName,
    parseRemoteSaveFileName,
    planRemoteSaveCleanup,
    remoteSaveCleanupGraceMs,
} from './remoteSaveCleanup'

const now = 10_000_000_000

describe('getRemoteSavePayloadName', () => {
    it('extracts the character id from remote save payload files', () => {
        expect(getRemoteSavePayloadName('character-id.local.bin')).toBe('character-id')
    })

    it('ignores metadata and unrelated files', () => {
        expect(getRemoteSavePayloadName('character-id.local.bin.meta')).toBeNull()
        expect(getRemoteSavePayloadName('character-id.bin')).toBeNull()
        expect(getRemoteSavePayloadName('character-id.local.bin.bak')).toBeNull()
        expect(getRemoteSavePayloadName('character-id.local.bin.tmp')).toBeNull()
        expect(getRemoteSavePayloadName('.local.bin')).toBeNull()
    })
})

describe('getRemoteSaveCleanupAction', () => {
    it('keeps payloads for active characters', () => {
        expect(getRemoteSaveCleanupAction({
            fileName: 'active-character.local.bin',
            activeCharacterIds: new Set(['active-character']),
            hasMeta: false,
            now,
        })).toBe('keep')
    })

    it('creates metadata before deleting orphaned payloads', () => {
        expect(getRemoteSaveCleanupAction({
            fileName: 'orphan-character.local.bin',
            activeCharacterIds: new Set(),
            hasMeta: false,
            now,
        })).toBe('create-meta')
    })

    it('keeps orphaned payloads inside the cleanup grace period', () => {
        expect(getRemoteSaveCleanupAction({
            fileName: 'orphan-character.local.bin',
            activeCharacterIds: new Set(),
            hasMeta: true,
            metaLastUsed: now - remoteSaveCleanupGraceMs + 1,
            now,
        })).toBe('keep')
    })

    it('deletes orphaned payloads after the cleanup grace period', () => {
        expect(getRemoteSaveCleanupAction({
            fileName: 'orphan-character.local.bin',
            activeCharacterIds: new Set(),
            hasMeta: true,
            metaLastUsed: now - remoteSaveCleanupGraceMs - 1,
            now,
        })).toBe('delete')
    })

    it('keeps orphaned payloads with malformed metadata', () => {
        expect(getRemoteSaveCleanupAction({
            fileName: 'orphan-character.local.bin',
            activeCharacterIds: new Set(),
            hasMeta: true,
            metaLastUsed: 'not-a-number',
            now,
        })).toBe('keep')
    })
})

describe('parseRemoteSaveFileName', () => {
    it('classifies every remote file kind', () => {
        expect(parseRemoteSaveFileName('chat-a-b.local.bin')).toEqual({ kind: 'payload', payloadName: 'chat-a-b' })
        expect(parseRemoteSaveFileName('chat-a-b.local.bin.bak')).toEqual({ kind: 'backup', payloadName: 'chat-a-b' })
        expect(parseRemoteSaveFileName('chat-a-b.local.bin.tmp')).toEqual({ kind: 'temp', payloadName: 'chat-a-b' })
        expect(parseRemoteSaveFileName('chat-a-b.local.bin.corrupt-1700000000000')).toEqual({ kind: 'corrupt', payloadName: 'chat-a-b' })
        expect(parseRemoteSaveFileName('chat-a-b.local.bin.meta')).toEqual({ kind: 'meta', payloadName: 'chat-a-b' })
        expect(parseRemoteSaveFileName('chat-a-b.local.bin.bak.meta').kind).toBe('other')
        expect(parseRemoteSaveFileName('readme.txt').kind).toBe('other')
    })
})

describe('getActiveRemotePayloadNames', () => {
    it('contains every chaId and the chat file of every chat with a string id', () => {
        const names = getActiveRemotePayloadNames([
            { chaId: 'cha-a', chats: [{ id: 'c1' }, { id: 'c2' }, { name: 'no id' }, { id: 5 }] },
            { chaId: 'group-1', chats: [{ id: 'g1' }] },
            { chaId: 'no-chats', chats: { not: 'an array' } },
            { name: 'no chaId', chats: [{ id: 'x' }] },
        ])
        expect([...names].sort()).toEqual([
            'cha-a', 'chat-cha-a-c1', 'chat-cha-a-c2', 'chat-group-1-g1', 'group-1', 'no-chats',
        ].sort())
        expect(getRemoteChatPayloadName('cha-a', 'c1')).toBe('chat-cha-a-c1')
    })
})

describe('getRemoteSaveCleanupAction for chat files', () => {
    const active = getActiveRemotePayloadNames([{ chaId: 'cha-a', chats: [{ id: 'c1' }] }])

    it('keeps active chat files and their backups', () => {
        for (const fileName of ['chat-cha-a-c1.local.bin', 'chat-cha-a-c1.local.bin.bak']) {
            expect(getRemoteSaveCleanupAction({ fileName, activeCharacterIds: active, hasMeta: false, now })).toBe('keep')
        }
    })

    it('treats a backup of an inactive chat like its main file', () => {
        const old = { activeCharacterIds: active, hasMeta: true, metaLastUsed: now - remoteSaveCleanupGraceMs - 1, now }
        expect(getRemoteSaveCleanupAction({ fileName: 'chat-cha-a-c2.local.bin', ...old })).toBe('delete')
        expect(getRemoteSaveCleanupAction({ fileName: 'chat-cha-a-c2.local.bin.bak', ...old })).toBe('delete')
        expect(getRemoteSaveCleanupAction({ fileName: 'chat-cha-a-c2.local.bin.bak', activeCharacterIds: active, hasMeta: false, now })).toBe('create-meta')
    })

    it('deletes temp files and never deletes corrupt files', () => {
        expect(getRemoteSaveCleanupAction({ fileName: 'chat-cha-a-c1.local.bin.tmp', activeCharacterIds: active, hasMeta: false, now })).toBe('delete')
        expect(getRemoteSaveCleanupAction({
            fileName: 'chat-cha-a-c2.local.bin.corrupt-123',
            activeCharacterIds: active,
            hasMeta: true,
            metaLastUsed: 0,
            now,
        })).toBe('ignore')
    })
})

describe('planRemoteSaveCleanup', () => {
    it('groups a main file with its backup and meta, deletes temp files, ignores corrupt files', () => {
        const active = getActiveRemotePayloadNames([{ chaId: 'cha-a', chats: [{ id: 'c1' }] }])
        const plan = planRemoteSaveCleanup([
            'cha-a.local.bin',
            'chat-cha-a-c1.local.bin',
            'chat-cha-a-c1.local.bin.bak',
            'chat-cha-a-c1.local.bin.tmp',
            'chat-cha-a-c2.local.bin',
            'chat-cha-a-c2.local.bin.bak',
            'chat-cha-a-c2.local.bin.meta',
            'chat-cha-a-c3.local.bin.bak',
            'chat-cha-a-c3.local.bin.corrupt-123',
            'deleted-character.local.bin',
            'deleted-character.local.bin.tmp',
            'unrelated.txt',
        ], active)
        expect(plan.deleteNow.sort()).toEqual(['chat-cha-a-c1.local.bin.tmp', 'deleted-character.local.bin.tmp'])
        expect(plan.inactive).toEqual([
            {
                payloadName: 'chat-cha-a-c2',
                files: ['chat-cha-a-c2.local.bin', 'chat-cha-a-c2.local.bin.bak'],
                metaFile: 'chat-cha-a-c2.local.bin.meta',
                hasMeta: true,
            },
            {
                //a backup without its main file (crash between the renames) still has a grace period
                payloadName: 'chat-cha-a-c3',
                files: ['chat-cha-a-c3.local.bin.bak'],
                metaFile: 'chat-cha-a-c3.local.bin.meta',
                hasMeta: false,
            },
            {
                payloadName: 'deleted-character',
                files: ['deleted-character.local.bin'],
                metaFile: 'deleted-character.local.bin.meta',
                hasMeta: false,
            },
        ])
    })

    it('decides inactive groups with the meta file', () => {
        expect(getInactiveRemoteSaveAction({ hasMeta: false, now })).toBe('create-meta')
        expect(getInactiveRemoteSaveAction({ hasMeta: true, metaLastUsed: now - remoteSaveCleanupGraceMs + 1, now })).toBe('keep')
        expect(getInactiveRemoteSaveAction({ hasMeta: true, metaLastUsed: now - remoteSaveCleanupGraceMs - 1, now })).toBe('delete')
        expect(getInactiveRemoteSaveAction({ hasMeta: true, metaLastUsed: 'bad', now })).toBe('keep')
    })
})
