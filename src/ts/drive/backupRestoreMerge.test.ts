import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../storage/database.svelte'

//the real preset helpers need a fully populated database; these keep only what the merge relies on
vi.mock(import('../storage/database.svelte'), () => ({
    saveCurrentPreset: (db: Database) => {
        db.botPresets[db.botPresetsId] = { ...db.botPresets[db.botPresetsId], mainPrompt: db.mainPrompt }
    },
    setPreset: (db: Database, preset: Database['botPresets'][number]) => {
        db.mainPrompt = preset.mainPrompt ?? db.mainPrompt
    },
}) as unknown as typeof import('../storage/database.svelte'))
import { isFullBackupRestore } from './backupRestoreCategories'
import { mergePartialBackup } from './backupRestoreMerge'

function makeDb(tag: string, extra: Record<string, unknown> = {}): Database {
    return {
        characters: [{ name: `${tag}-char`, chaId: `${tag}-id` }],
        characterOrder: [`${tag}-id`],
        personas: [{ name: `${tag}-persona`, icon: '', personaPrompt: '' }],
        selectedPersona: 0,
        username: `${tag}-user`,
        userIcon: `${tag}-icon`,
        personaPrompt: `${tag}-persona-prompt`,
        userNote: '',
        botPresets: [{ name: `${tag}-preset`, mainPrompt: `${tag}-preset-main` }],
        botPresetsId: 0,
        modules: [{ id: `${tag}-module` }],
        enabledModules: [`${tag}-module`],
        plugins: [{ name: `${tag}-plugin` }],
        pluginCustomStorage: { tag },
        currentPluginProvider: `${tag}-provider`,
        mainPrompt: `${tag}-main`,
        theme: `${tag}-theme`,
        account: { id: `${tag}-account` },
        ...extra,
    } as unknown as Database
}

describe('backupRestoreMerge', () => {
    it('detects a full restore only when every category is selected', () => {
        expect(isFullBackupRestore(['characters', 'personas', 'presets', 'modules', 'plugins', 'settings'])).toBe(true)
        expect(isFullBackupRestore(['characters', 'settings'])).toBe(false)
    })

    it('takes only the selected categories from the backup', () => {
        const merged = mergePartialBackup(makeDb('current'), makeDb('backup'), new Set(['characters', 'modules']))

        expect(merged.characters[0].name).toBe('backup-char')
        expect(merged.characterOrder).toEqual(['backup-id'])
        expect(merged.enabledModules).toEqual(['backup-module'])

        expect(merged.username).toBe('current-user')
        expect(merged.botPresets[0].name).toBe('current-preset')
        expect(merged.plugins[0].name).toBe('current-plugin')
        expect(merged.theme).toBe('current-theme')
        expect(merged.mainPrompt).toBe('current-main')
    })

    it('restores settings without touching the categorized fields and keeps the account', () => {
        const merged = mergePartialBackup(
            makeDb('current'),
            makeDb('backup', { backupOnlySetting: true }),
            new Set(['settings', 'presets'])
        )

        expect(merged.theme).toBe('backup-theme')
        expect((merged as any).backupOnlySetting).toBe(true)
        expect(merged.characters[0].name).toBe('current-char')
        expect(merged.account).toEqual({ id: 'current-account' })
    })

    it('keeps the active preset consistent with the top level settings', () => {
        //presets from the backup, settings from the current database:
        //the backup's live edits are stored in its preset and then applied to the result
        const presetsOnly = mergePartialBackup(makeDb('current'), makeDb('backup'), new Set(['presets']))
        expect(presetsOnly.botPresets[0].mainPrompt).toBe('backup-main')
        expect(presetsOnly.mainPrompt).toBe('backup-main')
        expect(presetsOnly.theme).toBe('current-theme')

        //settings from the backup, presets kept: the current active preset is re-applied
        const settingsOnly = mergePartialBackup(makeDb('current'), makeDb('backup'), new Set(['settings']))
        expect(settingsOnly.botPresets[0].mainPrompt).toBe('current-main')
        expect(settingsOnly.mainPrompt).toBe('current-main')
        expect(settingsOnly.theme).toBe('backup-theme')
    })
})
