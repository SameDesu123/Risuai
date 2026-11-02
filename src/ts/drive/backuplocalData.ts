import type { Database } from "../storage/database.svelte"

/**
 * Parts of the data that can be chosen for a local backup (the leaves of localBackupTree).
 * - characters: characters and groups with their chats, and the character order (folders)
 * - characterProfileImages: profile images of characters and groups, and folder images
 * - characterAssets: the other character assets (emotion images, additional assets, VITS files, card assets)
 * - presets: prompt presets
 * - personas: personas
 * - modules: modules and which of them are enabled
 * - plugins: plugins and plugin storage
 * - otherSettings: everything else in the database, except the account
 */
export const localBackupSections = [
    'characters',
    'characterProfileImages',
    'characterAssets',
    'presets',
    'personas',
    'modules',
    'plugins',
    'otherSettings',
] as const

export type LocalBackupSection = typeof localBackupSections[number]

export type LocalBackupGroup = 'characterGroup' | 'characterAssetGroup' | 'settingsGroup'

export type LocalBackupTreeNode =
    | { id: LocalBackupSection }
    | { id: LocalBackupGroup, children: LocalBackupTreeNode[] }

/** How the sections are shown in the backup selection. Every section appears exactly once. */
export const localBackupTree: LocalBackupTreeNode[] = [
    {
        id: 'characterGroup',
        children: [
            { id: 'characters' },
            {
                id: 'characterAssetGroup',
                children: [
                    { id: 'characterProfileImages' },
                    { id: 'characterAssets' },
                ],
            },
        ],
    },
    {
        id: 'settingsGroup',
        children: [
            { id: 'presets' },
            { id: 'personas' },
            { id: 'modules' },
            { id: 'plugins' },
            { id: 'otherSettings' },
        ],
    },
]

/** The sections below a tree node (the node itself, if it is a section). */
export function getLocalBackupTreeSections(node: LocalBackupTreeNode): LocalBackupSection[] {
    if ('children' in node) {
        return node.children.flatMap(getLocalBackupTreeSections)
    }
    return [node.id]
}

export function isLocalBackupSection(value: unknown): value is LocalBackupSection {
    return (localBackupSections as readonly unknown[]).includes(value)
}

/** Sections in their canonical order, without duplicates and unknown values. */
export function normalizeLocalBackupSections(sections: Iterable<unknown>): LocalBackupSection[] {
    const selected = new Set(sections)
    return localBackupSections.filter((section) => selected.has(section))
}

/** sections that are stored in the database; the others only decide which asset files are written */
const databaseSections = ['characters', 'presets', 'personas', 'modules', 'plugins', 'otherSettings'] as const satisfies readonly LocalBackupSection[]

/** database fields owned by a section. Every other field, except the account, belongs to otherSettings. */
const sectionDatabaseFields = {
    characters: ['characters', 'characterOrder'],
    presets: ['botPresets', 'botPresetsId'],
    //the selected persona is mirrored into the top level fields, so they are restored together
    personas: ['personas', 'selectedPersona', 'username', 'userIcon', 'personaPrompt', 'userNote'],
    modules: ['modules', 'enabledModules'],
    plugins: ['plugins', 'pluginV2', 'pluginCustomStorage'],
} as const satisfies Partial<Record<LocalBackupSection, readonly (keyof Database)[]>>

const sectionOwnedFields = new Set<string>(Object.values(sectionDatabaseFields).flat())

function isOtherSettingsField(key: string) {
    return key !== 'account' && !sectionOwnedFields.has(key)
}

/** Whether every section is selected. Such a backup is a regular full backup. */
export function isFullLocalBackup(sections: ReadonlySet<LocalBackupSection>) {
    return localBackupSections.every((section) => sections.has(section))
}

/**
 * Whether the whole database is part of the backup. Its database replaces the current one on restore,
 * like the database of a full backup; otherwise only the selected sections are applied.
 */
export function includesWholeDatabase(sections: ReadonlySet<LocalBackupSection>) {
    return databaseSections.every((section) => sections.has(section))
}

/** backup entry holding a database that replaces the current one on restore */
export const localBackupDatabaseName = 'database.risudat'

/**
 * backup entry holding the database of a backup with only some sections, which are applied on top of the current data.
 * It is named differently on purpose: versions that do not know selective backups find no database
 * and refuse to load the file, instead of replacing the database with a partial one.
 */
export const localBackupSelectiveDatabaseName = 'selective.risudat'

/** backup entry listing the sections of a selective backup */
export const localBackupManifestName = 'manifest.risudat'

type LocalBackupManifest = { version: 1, sections: LocalBackupSection[] }

export function createLocalBackupManifest(sections: Iterable<LocalBackupSection>): string {
    const manifest: LocalBackupManifest = { version: 1, sections: normalizeLocalBackupSections(sections) }
    return JSON.stringify(manifest)
}

/** @returns the sections listed in a manifest, or null when it is not a valid manifest */
export function parseLocalBackupManifest(text: string): Set<LocalBackupSection> | null {
    try {
        const manifest = JSON.parse(text) as Partial<LocalBackupManifest> | null
        if (manifest?.version !== 1 || !Array.isArray(manifest.sections)) {
            return null
        }
        return new Set(normalizeLocalBackupSections(manifest.sections))
    } catch {
        return null
    }
}

/** fields the save encoder writes as separate blocks, so they must exist even when their section is left out */
function withEncoderDefaults(db: Record<string, unknown>) {
    db.characters ??= []
    db.characterOrder ??= []
    db.botPresets ??= []
    db.modules ??= []
    db.loadouts ??= []
    db.plugins ??= []
    db.pluginCustomStorage ??= {}
    return db as unknown as Database
}

/**
 * The database as written to a backup: only the fields of the selected sections, never the account.
 * With every database section selected this is the whole database without the account.
 */
export function toLocalBackupDatabase(db: Database, sections: ReadonlySet<LocalBackupSection>): Database {
    const source = db as unknown as Record<string, unknown>
    const result: Record<string, unknown> = {}

    if (sections.has('otherSettings')) {
        for (const key of Object.keys(source)) {
            if (isOtherSettingsField(key)) {
                result[key] = source[key]
            }
        }
    }
    for (const [section, fields] of Object.entries(sectionDatabaseFields)) {
        if (!sections.has(section as LocalBackupSection)) {
            continue
        }
        for (const field of fields) {
            if (field in source) {
                result[field] = source[field]
            }
        }
    }

    return withEncoderDefaults(result)
}

/**
 * Applies the database of a selective backup on top of the current database:
 * the fields of the backed up sections come from the backup, everything else (and always the account) from the current database.
 *
 * The values of the active prompt preset are stored in the top level fields, which belong to otherSettings.
 * When only one of presets and otherSettings comes from the backup, applyActivePreset is called with the result,
 * so those values are loaded again from the preset list that is now in use.
 */
export function mergeLocalBackup(
    backup: Database,
    current: Database,
    sections: ReadonlySet<LocalBackupSection>,
    applyActivePreset?: (db: Database) => void,
): Database {
    const backupSource = backup as unknown as Record<string, unknown>
    const currentSource = current as unknown as Record<string, unknown>
    const result: Record<string, unknown> = {}

    //like a full restore, other settings that only exist in the replaced database are not carried over
    const otherSettingsSource = sections.has('otherSettings') ? backupSource : currentSource
    for (const key of Object.keys(otherSettingsSource)) {
        if (isOtherSettingsField(key)) {
            result[key] = otherSettingsSource[key]
        }
    }
    for (const [section, fields] of Object.entries(sectionDatabaseFields)) {
        const source = sections.has(section as LocalBackupSection) ? backupSource : currentSource
        for (const field of fields) {
            if (field in source) {
                result[field] = source[field]
            }
        }
    }
    result.account = current.account

    const merged = withEncoderDefaults(result)
    if (applyActivePreset && sections.has('presets') !== sections.has('otherSettings')) {
        applyActivePreset(merged)
    }
    return merged
}

export type BackupAssetLabel = { charName: string, assetName: string }

type LocalBackupAssetSource = Partial<Pick<Database,
    | 'characters' | 'characterOrder' | 'userIcon' | 'customBackground' | 'personas'
    | 'modules' | 'botPresets' | 'NAIImgConfig' | 'wavespeedImage'
>>

/** asset references that are not stored as local asset files (URLs, data URIs, card placeholders such as ccdefault:) */
function isLocalAssetReference(key: unknown): key is string {
    return typeof key === 'string'
        && key !== ''
        && !/^[a-z][a-z0-9+.-]*:/i.test(key)
}

/** Asset files referenced by the selected sections, labeled for error messages. */
export function collectLocalBackupAssets(db: LocalBackupAssetSource, sections: ReadonlySet<LocalBackupSection>): Map<string, BackupAssetLabel> {
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

    for (const char of db.characters ?? []) {
        if (!char) {
            continue
        }
        const charName = char.name || 'Unknown Character'
        if (sections.has('characterProfileImages')) {
            add(char.image, charName, 'Profile Image')
        }
        if (!sections.has('characterAssets')) {
            continue
        }
        for (const emotion of char.emotionImages ?? []) {
            if (emotion) {
                add(emotion[1], charName, emotion[0])
            }
        }
        if (char.type === 'group') {
            continue
        }
        for (const asset of char.additionalAssets ?? []) {
            if (asset) {
                add(asset[1], charName, asset[0])
            }
        }
        for (const [name, file] of Object.entries(char.vits?.files ?? {})) {
            add(file, charName, name)
        }
        for (const asset of char.ccAssets ?? []) {
            if (asset) {
                add(asset.uri, charName, asset.name)
            }
        }
    }

    if (sections.has('characterProfileImages')) {
        for (const item of db.characterOrder ?? []) {
            if (item && typeof item !== 'string') {
                add(item.imgFile, 'Folder', `${item.name} Folder Image`)
                add(item.img, 'Folder', `${item.name} Folder Image`)
            }
        }
    }

    if (sections.has('personas')) {
        add(db.userIcon, 'User Settings', 'User Icon')
        for (const persona of db.personas ?? []) {
            if (!persona) {
                continue
            }
            add(persona.icon, 'Persona', `${persona.name} Icon`)
            addModule(persona.embeddedModule, 'Persona')
        }
    }

    if (sections.has('modules')) {
        for (const module of db.modules ?? []) {
            addModule(module, 'Module')
        }
    }

    if (sections.has('presets')) {
        for (const preset of db.botPresets ?? []) {
            if (preset) {
                add(preset.image, 'Preset', `${preset.name} Preset Image`)
            }
        }
    }

    if (sections.has('otherSettings')) {
        add(db.customBackground, 'User Settings', 'Custom Background')
        add(db.NAIImgConfig?.image, 'Image Generation', 'NovelAI Image')
        add(db.NAIImgConfig?.character_image, 'Image Generation', 'NovelAI Character Image')
        add(db.wavespeedImage?.reference_image, 'Image Generation', 'Wavespeed Reference Image')
    }

    return assets
}
