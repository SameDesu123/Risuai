import { describe, expect, it } from 'vitest'
import type { Database } from '../storage/database.svelte'
import {
    collectSettingsBackupAssets,
    localBackupDatabaseName,
    localBackupSettingsDatabaseName,
    mergeSettingsBackup,
    toSettingsBackupDatabase,
} from './backuplocalData'

const asDatabase = (data: unknown) => data as Database

describe('backuplocalData', () => {
    it('stores settings backups under their own database entry name', () => {
        expect(localBackupSettingsDatabaseName).not.toBe(localBackupDatabaseName)
    })

    it('collects assets of settings, personas, modules and presets, but not of characters or folders', () => {
        const assets = collectSettingsBackupAssets(asDatabase({
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
            wavespeedImage: { reference_image: 'data:image/png;base64,AAAA' },
            characters: [{ image: 'assets/character.png', emotionImages: [['happy', 'assets/emotion.png']] }],
            characterOrder: [{ name: 'Folder', imgFile: 'assets/folder.png', data: [], color: '', id: 'f' }],
        }))

        expect(Array.from(assets.keys())).toEqual([
            'assets/user.png',
            'assets/background.webp',
            'assets/persona.png',
            'assets/persona-module-icon.png',
            'assets/persona-module-asset.png',
            'assets/module-icon.png',
            'assets/module-bgm.mp3',
            'assets/preset.png',
            'assets/nai.png',
        ])
        expect(assets.get('assets/module-bgm.mp3')).toEqual({ charName: 'Module', assetName: 'Module A / bgm' })
        expect(assets.get('assets/persona.png')).toEqual({ charName: 'Persona', assetName: 'Persona A Icon' })
    })

    it('keeps the first label of an asset shared by several owners', () => {
        const assets = collectSettingsBackupAssets(asDatabase({
            userIcon: 'assets/shared.png',
            personas: [{ name: 'Persona A', icon: 'assets/shared.png' }],
        }))

        expect(assets.size).toBe(1)
        expect(assets.get('assets/shared.png')).toEqual({ charName: 'User Settings', assetName: 'User Icon' })
    })

    it('tolerates a database without optional settings', () => {
        expect(collectSettingsBackupAssets(asDatabase({})).size).toBe(0)
    })

    it('leaves characters, the character order and the account out of a settings backup', () => {
        const db = asDatabase({
            characters: [{ chaId: 'a', name: 'Character A' }],
            characterOrder: ['a'],
            account: { id: 'user', token: 'secret' },
            mainPrompt: 'main prompt',
            modules: [{ id: 'module' }],
        })

        const settingsDb = toSettingsBackupDatabase(db)

        expect(settingsDb.characters).toEqual([])
        expect(settingsDb.characterOrder).toEqual([])
        expect(settingsDb.account).toBeUndefined()
        expect(settingsDb.mainPrompt).toBe('main prompt')
        expect(settingsDb.modules).toEqual([{ id: 'module' }])
        //the live database is not modified
        expect(db.characters).toHaveLength(1)
        expect(db.account).toEqual({ id: 'user', token: 'secret' })
    })

    it('restores a settings backup without touching the current characters and account', () => {
        const currentCharacters = [{ chaId: 'current', name: 'Current Character' }]
        const currentOrder = ['current']
        const currentAccount = { id: 'user', token: 'current-token' }
        const current = asDatabase({
            characters: currentCharacters,
            characterOrder: currentOrder,
            account: currentAccount,
            mainPrompt: 'current prompt',
            personas: [{ name: 'Current Persona' }],
            onlyInCurrent: true,
        })
        const backup = asDatabase({
            characters: [],
            characterOrder: [],
            mainPrompt: 'backup prompt',
            personas: [{ name: 'Backup Persona' }],
            pluginCustomStorage: { _coldpluginIndex: 'index' },
        })

        const merged = mergeSettingsBackup(backup, current)

        expect(merged.characters).toBe(currentCharacters)
        expect(merged.characterOrder).toBe(currentOrder)
        expect(merged.account).toBe(currentAccount)
        expect(merged.mainPrompt).toBe('backup prompt')
        expect(merged.personas).toEqual([{ name: 'Backup Persona' }])
        expect(merged.pluginCustomStorage).toEqual({ _coldpluginIndex: 'index' })
        //like a full restore, fields that only exist in the current database are not carried over
        expect('onlyInCurrent' in merged).toBe(false)
    })

    it('restores a settings backup into an empty database', () => {
        const merged = mergeSettingsBackup(
            asDatabase({ mainPrompt: 'backup prompt', characters: [], characterOrder: [] }),
            asDatabase({}),
        )

        expect(merged.characters).toEqual([])
        expect(merged.characterOrder).toEqual([])
        expect(merged.account).toBeUndefined()
        expect(merged.mainPrompt).toBe('backup prompt')
    })
})
