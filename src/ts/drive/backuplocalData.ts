import type { Database } from "../storage/database.svelte"

/**
 * - full: everything, including every character asset
 * - partial: everything, but only character profile images
 * - settings: everything except characters, chats and the account (restored by merging into the current data)
 */
export type LocalBackupMode = 'full' | 'partial' | 'settings'

/** backup entry holding the database of a full or partial backup; restoring it replaces the whole database */
export const localBackupDatabaseName = 'database.risudat'

/**
 * backup entry holding the database of a settings backup; restoring it keeps the current characters.
 * It is named differently on purpose: versions that do not know settings backups find no database
 * and refuse to load the file, instead of replacing the database with one that has no characters.
 */
export const localBackupSettingsDatabaseName = 'settings.risudat'

export type BackupAssetLabel = { charName: string, assetName: string }

type SettingsBackupAssetSource = Partial<Pick<Database,
    'userIcon' | 'customBackground' | 'personas' | 'modules' | 'botPresets' | 'NAIImgConfig' | 'wavespeedImage'
>>

/** asset references that are not stored as local asset files */
function isLocalAssetReference(key: unknown): key is string {
    return typeof key === 'string'
        && key !== ''
        && !/^(?:https?:|data:|blob:)/i.test(key)
}

/**
 * Assets referenced by the parts of the database that a settings backup contains.
 * Character assets and folder images are left out, since characters and the character order are not part of it.
 */
export function collectSettingsBackupAssets(db: SettingsBackupAssetSource): Map<string, BackupAssetLabel> {
    const assets = new Map<string, BackupAssetLabel>()
    const add = (key: unknown, charName: string, assetName: string) => {
        if (isLocalAssetReference(key) && !assets.has(key)) {
            assets.set(key, { charName, assetName })
        }
    }
    const addModule = (module: Database['modules'][number] | undefined, owner: string) => {
        if (!module) {
            return
        }
        const moduleName = module.name || 'Unnamed Module'
        add(module.icon, owner, `${moduleName} Icon`)
        for (const asset of module.assets ?? []) {
            if (asset) {
                add(asset[1], owner, `${moduleName} / ${asset[0]}`)
            }
        }
    }

    add(db.userIcon, 'User Settings', 'User Icon')
    add(db.customBackground, 'User Settings', 'Custom Background')

    for (const persona of db.personas ?? []) {
        if (!persona) {
            continue
        }
        add(persona.icon, 'Persona', `${persona.name} Icon`)
        addModule(persona.embeddedModule, 'Persona')
    }

    for (const module of db.modules ?? []) {
        addModule(module, 'Module')
    }

    for (const preset of db.botPresets ?? []) {
        if (preset) {
            add(preset.image, 'Preset', `${preset.name} Preset Image`)
        }
    }

    add(db.NAIImgConfig?.image, 'Image Generation', 'NovelAI Image')
    add(db.NAIImgConfig?.character_image, 'Image Generation', 'NovelAI Character Image')
    add(db.wavespeedImage?.reference_image, 'Image Generation', 'Wavespeed Reference Image')

    return assets
}

/** The database as written to a settings backup: without characters, the character order and the account. */
export function toSettingsBackupDatabase(db: Database): Database {
    return {
        ...db,
        characters: [],
        characterOrder: [],
        account: undefined,
    }
}

/**
 * Applies a restored settings backup on top of the current database.
 * Everything comes from the backup, except the fields a settings backup leaves out
 * (characters with their chats, the character order and the account), which are kept from the current database.
 */
export function mergeSettingsBackup(backup: Database, current: Database): Database {
    return {
        ...backup,
        characters: current.characters ?? [],
        characterOrder: current.characterOrder ?? [],
        account: current.account,
    }
}
