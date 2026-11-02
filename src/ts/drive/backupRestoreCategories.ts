/**
 * Categories the user can pick when restoring a local backup.
 * Kept free of heavy imports so UI components can use it directly.
 */
export const backupRestoreCategories = [
    'characters',
    'personas',
    'presets',
    'modules',
    'plugins',
    'settings',
] as const

export type BackupRestoreCategory = typeof backupRestoreCategories[number]

/**
 * Database fields owned by each category. Every field that is not listed here
 * (except `account`, which always stays as it is) belongs to `settings`.
 */
export const backupRestoreCategoryFields: Record<Exclude<BackupRestoreCategory, 'settings'>, readonly string[]> = {
    characters: ['characters', 'characterOrder'],
    personas: ['personas', 'selectedPersona', 'username', 'userIcon', 'personaPrompt', 'userNote'],
    presets: ['botPresets', 'botPresetsId'],
    modules: ['modules', 'enabledModules'],
    plugins: ['plugins', 'pluginCustomStorage', 'currentPluginProvider'],
}

export function isFullBackupRestore(selected: Iterable<BackupRestoreCategory>): boolean {
    const set = new Set(selected)
    return backupRestoreCategories.every((category) => set.has(category))
}
