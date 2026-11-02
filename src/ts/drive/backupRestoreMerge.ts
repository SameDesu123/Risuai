import { saveCurrentPreset, setPreset, type Database } from "../storage/database.svelte";
import { backupRestoreCategoryFields, type BackupRestoreCategory } from "./backupRestoreCategories";

/**
 * Builds the database for a partial restore: fields of the selected categories come
 * from the backup, everything else is kept from the current database.
 */
export function mergePartialBackup(current: Database, backup: Database, selected: Set<BackupRestoreCategory>): Database {
    const categorizedFields = new Set(Object.values(backupRestoreCategoryFields).flat())
    const merged: Record<string, unknown> = {}

    const settingsSource = (selected.has('settings') ? backup : current) as unknown as Record<string, unknown>
    for (const key of Object.keys(settingsSource)) {
        if (categorizedFields.has(key) || key === 'account') {
            continue
        }
        merged[key] = settingsSource[key]
    }

    for (const [category, fields] of Object.entries(backupRestoreCategoryFields)) {
        const source = (selected.has(category as BackupRestoreCategory) ? backup : current) as unknown as Record<string, unknown>
        for (const field of fields) {
            if (field in source) {
                merged[field] = source[field]
            }
        }
    }

    //the account is tied to this device, never take it from a backup
    merged.account = current.account

    const result = merged as unknown as Database

    //the active preset's values (prompts, model, parameters...) live in the top level settings.
    //when presets and settings come from different databases, re-apply the active preset
    //so they stay consistent and switching presets later does not overwrite one with the other
    if (selected.has('presets') !== selected.has('settings')) {
        const presetSource = selected.has('presets') ? backup : current
        try {
            //store unsaved edits of the active preset before taking the preset list
            saveCurrentPreset(presetSource)
            result.botPresets = presetSource.botPresets
            const activePreset = result.botPresets?.[result.botPresetsId]
            if (activePreset) {
                setPreset(result, activePreset)
            }
        } catch (e) {
            console.error('Failed to sync the active preset for partial restore:', e)
        }
    }

    return result
}
