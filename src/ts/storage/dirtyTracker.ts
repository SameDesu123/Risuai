/**
 * Dirty Tracker - Track changed blocks
 * 
 * Tracks changed/deleted blocks for delta sync with Node.js server.
 */

// Changed block names (chaId, 'preset', 'modules', 'root')
const dirtyBlocks = new Set<string>()

// Deleted block names (mainly deleted character chaId)
const deletedBlocks = new Set<string>()

// Whether sync is enabled (true after initialization)
let syncEnabled = false

/**
 * Mark a block as dirty
 */
export function markBlockDirty(blockName: string) {
    if (syncEnabled) {
        dirtyBlocks.add(blockName)
        // Remove from deleted list if re-added after deletion
        deletedBlocks.delete(blockName)
    }
}

/**
 * Mark a block as deleted
 */
export function markBlockDeleted(blockName: string) {
    if (syncEnabled) {
        deletedBlocks.add(blockName)
        // Remove deleted block from dirty list
        dirtyBlocks.delete(blockName)
    }
}

/**
 * Return list of changed blocks
 */
export function getDirtyBlocks(): string[] {
    return Array.from(dirtyBlocks)
}

/**
 * Return list of deleted blocks
 */
export function getDeletedBlocks(): string[] {
    return Array.from(deletedBlocks)
}

/**
 * Clear dirty state (called after sync completes)
 */
export function clearDirtyState() {
    dirtyBlocks.clear()
    deletedBlocks.clear()
}

/**
 * Enable sync (called after initialization completes)
 */
export function enableSync() {
    syncEnabled = true
}

/**
 * Disable sync
 */
export function disableSync() {
    syncEnabled = false
}

/**
 * Check if sync is enabled
 */
export function isSyncEnabled(): boolean {
    return syncEnabled
}

/**
 * Check if there are pending changes
 */
export function hasPendingChanges(): boolean {
    return dirtyBlocks.size > 0 || deletedBlocks.size > 0
}

// Convenience functions

/**
 * Mark character as changed
 */
export function markCharacterDirty(chaId: string) {
    markBlockDirty(chaId)
}

/**
 * Mark character as deleted
 */
export function markCharacterDeleted(chaId: string) {
    markBlockDeleted(chaId)
}

/**
 * Mark bot preset as changed
 */
export function markPresetDirty() {
    markBlockDirty('preset')
}

/**
 * Mark modules as changed
 */
export function markModulesDirty() {
    markBlockDirty('modules')
}
