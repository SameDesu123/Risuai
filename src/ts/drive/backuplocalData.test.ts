import { describe, expect, it, vi } from 'vitest'
import type { Database } from '../storage/database.svelte'
import {
    collectLocalBackupAssets,
    createLocalBackupManifest,
    getLocalBackupTreeSections,
    includesWholeDatabase,
    isFullLocalBackup,
    localBackupDatabaseName,
    localBackupManifestName,
    localBackupSections,
    localBackupSelectiveDatabaseName,
    localBackupTree,
    mergeLocalBackup,
    parseLocalBackupManifest,
    toLocalBackupDatabase,
    type LocalBackupSection,
} from './backuplocalData'

const asDatabase = (data: unknown) => data as Database
const sections = (...values: LocalBackupSection[]) => new Set(values)
const allSections = () => new Set(localBackupSections)
const allSettings = () => sections('presets', 'personas', 'modules', 'plugins', 'otherSettings')

describe('backuplocalData', () => {
    it('shows every section exactly once in the tree', () => {
        const shown = localBackupTree.flatMap(getLocalBackupTreeSections)

        expect([...shown].sort()).toEqual([...localBackupSections].sort())
        expect(getLocalBackupTreeSections(localBackupTree[0])).toEqual(['characters', 'characterProfileImages', 'characterAssets'])
    })

    it('uses distinct backup entry names', () => {
        expect(new Set([localBackupDatabaseName, localBackupSelectiveDatabaseName, localBackupManifestName]).size).toBe(3)
    })

    it('tells full and whole database selections apart', () => {
        expect(isFullLocalBackup(allSections())).toBe(true)
        expect(includesWholeDatabase(allSections())).toBe(true)

        const withoutCharacterAssets = allSections()
        withoutCharacterAssets.delete('characterAssets')
        expect(isFullLocalBackup(withoutCharacterAssets)).toBe(false)
        expect(includesWholeDatabase(withoutCharacterAssets)).toBe(true)

        expect(includesWholeDatabase(allSettings())).toBe(false)
    })

    it('round trips the manifest in canonical order and rejects invalid ones', () => {
        const manifest = createLocalBackupManifest(['otherSettings', 'presets', 'presets'])

        expect(JSON.parse(manifest)).toEqual({ version: 1, sections: ['presets', 'otherSettings'] })
        expect(parseLocalBackupManifest(manifest)).toEqual(sections('presets', 'otherSettings'))
        expect(parseLocalBackupManifest('{"version":1,"sections":["modules","unknown"]}')).toEqual(sections('modules'))
        expect(parseLocalBackupManifest('{"version":2,"sections":["modules"]}')).toBeNull()
        expect(parseLocalBackupManifest('{"version":1}')).toBeNull()
        expect(parseLocalBackupManifest('not json')).toBeNull()
    })

    describe('toLocalBackupDatabase', () => {
        const db = () => asDatabase({
            characters: [{ chaId: 'a', name: 'Character A' }],
            characterOrder: ['a'],
            account: { id: 'user', token: 'secret' },
            mainPrompt: 'main prompt',
            botPresets: [{ name: 'Preset A' }],
            botPresetsId: 0,
            personas: [{ name: 'Persona A' }],
            selectedPersona: 0,
            username: 'Persona A',
            modules: [{ id: 'module' }],
            enabledModules: ['module'],
            plugins: [{ name: 'plugin' }],
            pluginCustomStorage: { key: 'value' },
            loadouts: [{ name: 'loadout' }],
        })

        it('keeps everything but the account when the whole database is selected', () => {
            const source = db()
            const backupDb = toLocalBackupDatabase(source, allSections())

            const { account, ...withoutAccount } = source
            expect(account).toBeDefined()
            expect(backupDb).toEqual(withoutAccount)
        })

        it('leaves characters and the account out of a settings backup without changing the live database', () => {
            const source = db()
            const backupDb = toLocalBackupDatabase(source, allSettings())

            expect(backupDb.characters).toEqual([])
            expect(backupDb.characterOrder).toEqual([])
            expect('account' in backupDb).toBe(false)
            expect(backupDb.mainPrompt).toBe('main prompt')
            expect(backupDb.modules).toEqual([{ id: 'module' }])
            expect(source.characters).toHaveLength(1)
            expect(source.account).toEqual({ id: 'user', token: 'secret' })
        })

        it('only writes the fields of the selected sections, with empty blocks for the save encoder', () => {
            const backupDb = toLocalBackupDatabase(db(), sections('presets'))

            expect(backupDb).toEqual({
                botPresets: [{ name: 'Preset A' }],
                botPresetsId: 0,
                characters: [],
                characterOrder: [],
                modules: [],
                loadouts: [],
                plugins: [],
                pluginCustomStorage: {},
            })
        })

        it('writes no database fields for a backup of asset files only', () => {
            const backupDb = toLocalBackupDatabase(db(), sections('characterProfileImages', 'characterAssets'))

            expect(backupDb.characters).toEqual([])
            expect(backupDb.mainPrompt).toBeUndefined()
            expect(backupDb.username).toBeUndefined()
        })
    })

    describe('mergeLocalBackup', () => {
        const current = () => asDatabase({
            characters: [{ chaId: 'current' }],
            characterOrder: ['current'],
            account: { id: 'user', token: 'current-token' },
            mainPrompt: 'current prompt',
            botPresets: [{ name: 'Current Preset' }],
            botPresetsId: 0,
            personas: [{ name: 'Current Persona' }],
            selectedPersona: 0,
            username: 'Current Persona',
            modules: [{ id: 'current-module' }],
            enabledModules: ['current-module'],
            pluginCustomStorage: { current: true },
            onlyInCurrent: true,
        })
        const backup = () => asDatabase({
            characters: [{ chaId: 'backup' }],
            characterOrder: ['backup'],
            mainPrompt: 'backup prompt',
            botPresets: [{ name: 'Backup Preset 1' }, { name: 'Backup Preset 2' }],
            botPresetsId: 1,
            personas: [{ name: 'Backup Persona' }],
            selectedPersona: 0,
            username: 'Backup Persona',
            modules: [{ id: 'backup-module' }],
            enabledModules: ['backup-module'],
            pluginCustomStorage: { _coldpluginIndex: 'index' },
            onlyInBackup: true,
        })

        it('restores a settings backup without touching the current characters and account', () => {
            const currentDb = current()
            const merged = mergeLocalBackup(backup(), currentDb, allSettings())

            expect(merged.characters).toBe(currentDb.characters)
            expect(merged.characterOrder).toBe(currentDb.characterOrder)
            expect(merged.account).toBe(currentDb.account)
            expect(merged.mainPrompt).toBe('backup prompt')
            expect(merged.personas).toEqual([{ name: 'Backup Persona' }])
            expect(merged.pluginCustomStorage).toEqual({ _coldpluginIndex: 'index' })
            //like a full restore, other settings that only exist in the replaced database are not carried over
            expect('onlyInCurrent' in merged).toBe(false)
            expect('onlyInBackup' in merged).toBe(true)
        })

        it('restores only the characters of a character backup', () => {
            const merged = mergeLocalBackup(backup(), current(), sections('characters', 'characterProfileImages'))

            expect(merged.characters).toEqual([{ chaId: 'backup' }])
            expect(merged.characterOrder).toEqual(['backup'])
            expect(merged.mainPrompt).toBe('current prompt')
            expect(merged.modules).toEqual([{ id: 'current-module' }])
            expect(merged.account).toEqual({ id: 'user', token: 'current-token' })
            expect('onlyInCurrent' in merged).toBe(true)
            expect('onlyInBackup' in merged).toBe(false)
        })

        it('restores the selected persona together with the persona list', () => {
            const merged = mergeLocalBackup(backup(), current(), sections('personas', 'modules'))

            expect(merged.personas).toEqual([{ name: 'Backup Persona' }])
            expect(merged.username).toBe('Backup Persona')
            expect(merged.enabledModules).toEqual(['backup-module'])
            expect(merged.botPresets).toEqual([{ name: 'Current Preset' }])
            expect(merged.mainPrompt).toBe('current prompt')
        })

        it('reloads the active preset when only one of presets and other settings is restored', () => {
            const applyActivePreset = vi.fn()

            const presetsOnly = mergeLocalBackup(backup(), current(), sections('presets'), applyActivePreset)
            expect(applyActivePreset).toHaveBeenCalledTimes(1)
            expect(applyActivePreset).toHaveBeenLastCalledWith(presetsOnly)
            expect(presetsOnly.botPresetsId).toBe(1)
            expect(presetsOnly.mainPrompt).toBe('current prompt')

            const otherSettingsOnly = mergeLocalBackup(backup(), current(), sections('otherSettings'), applyActivePreset)
            expect(applyActivePreset).toHaveBeenCalledTimes(2)
            expect(applyActivePreset).toHaveBeenLastCalledWith(otherSettingsOnly)
            expect(otherSettingsOnly.botPresets).toEqual([{ name: 'Current Preset' }])

            mergeLocalBackup(backup(), current(), allSettings(), applyActivePreset)
            mergeLocalBackup(backup(), current(), sections('personas'), applyActivePreset)
            expect(applyActivePreset).toHaveBeenCalledTimes(2)
        })

        it('restores into an empty database', () => {
            const merged = mergeLocalBackup(asDatabase({ mainPrompt: 'backup prompt' }), asDatabase({}), allSettings())

            expect(merged.characters).toEqual([])
            expect(merged.characterOrder).toEqual([])
            expect(merged.account).toBeUndefined()
            expect(merged.mainPrompt).toBe('backup prompt')
        })
    })

    describe('collectLocalBackupAssets', () => {
        const db = asDatabase({
            characters: [
                {
                    name: 'Character A',
                    image: 'assets/character.png',
                    emotionImages: [['happy', 'assets/emotion.png']],
                    additionalAssets: [['bgm', 'assets/additional.mp3', 'mp3']],
                    vits: { files: { model: 'assets/vits.onnx' } },
                    ccAssets: [{ name: 'main', uri: 'ccdefault:' }, { name: 'card', uri: 'assets/card.png' }],
                },
                { type: 'group', name: 'Group A', image: 'assets/group.png', emotionImages: [] },
            ],
            characterOrder: ['a', { name: 'Folder', imgFile: 'assets/folder.png', img: 'data:image/png;base64,AAAA', data: [], color: '', id: 'f' }],
            userIcon: 'assets/user.png',
            customBackground: 'assets/background.webp',
            personas: [
                {
                    name: 'Persona A',
                    icon: 'assets/persona.png',
                    embeddedModule: {
                        name: 'Persona Module',
                        icon: 'assets/persona-module-icon.png',
                        assets: [['smile', 'assets/persona-module-asset.png', 'png']],
                    },
                },
                { name: 'Persona Without Icon', icon: '' },
            ],
            modules: [
                {
                    name: 'Module A',
                    icon: 'assets/module-icon.png',
                    assets: [
                        ['bgm', 'assets/module-bgm.mp3', 'mp3'],
                        ['remote', 'https://example.com/remote.png', 'png'],
                    ],
                },
            ],
            botPresets: [{ name: 'Preset A', image: 'assets/preset.png' }, { name: 'Preset B' }],
            NAIImgConfig: { image: 'assets/nai.png', character_image: '' },
            wavespeedImage: { reference_image: 'blob:https://example.com/image' },
        })
        const collect = (...values: LocalBackupSection[]) => Array.from(collectLocalBackupAssets(db, sections(...values)).keys())

        it('collects the assets of every section', () => {
            const assets = collectLocalBackupAssets(db, allSections())

            expect(Array.from(assets.keys())).toEqual([
                'assets/character.png',
                'assets/emotion.png',
                'assets/additional.mp3',
                'assets/vits.onnx',
                'assets/card.png',
                'assets/group.png',
                'assets/folder.png',
                'assets/user.png',
                'assets/persona.png',
                'assets/persona-module-icon.png',
                'assets/persona-module-asset.png',
                'assets/module-icon.png',
                'assets/module-bgm.mp3',
                'assets/preset.png',
                'assets/background.webp',
                'assets/nai.png',
            ])
            expect(assets.get('assets/module-bgm.mp3')).toEqual({ charName: 'Module', assetName: 'Module A / bgm' })
            expect(assets.get('assets/emotion.png')).toEqual({ charName: 'Character A', assetName: 'happy' })
        })

        it('collects character images separately from the other character assets', () => {
            expect(collect('characterProfileImages')).toEqual(['assets/character.png', 'assets/group.png', 'assets/folder.png'])
            expect(collect('characterAssets')).toEqual(['assets/emotion.png', 'assets/additional.mp3', 'assets/vits.onnx', 'assets/card.png'])
            //the character data itself references no asset files of its own
            expect(collect('characters')).toEqual([])
        })

        it('collects the assets of the selected settings only', () => {
            expect(collect('personas')).toEqual([
                'assets/user.png',
                'assets/persona.png',
                'assets/persona-module-icon.png',
                'assets/persona-module-asset.png',
            ])
            expect(collect('presets')).toEqual(['assets/preset.png'])
            expect(collect('plugins')).toEqual([])
            expect(collect('otherSettings')).toEqual(['assets/background.webp', 'assets/nai.png'])
        })

        it('keeps the first label of an asset shared by several owners', () => {
            const assets = collectLocalBackupAssets(asDatabase({
                userIcon: 'assets/shared.png',
                personas: [{ name: 'Persona A', icon: 'assets/shared.png' }],
            }), allSections())

            expect(assets.size).toBe(1)
            expect(assets.get('assets/shared.png')).toEqual({ charName: 'User Settings', assetName: 'User Icon' })
        })

        it('tolerates a database without optional data', () => {
            expect(collectLocalBackupAssets(asDatabase({}), allSections()).size).toBe(0)
        })
    })
})
