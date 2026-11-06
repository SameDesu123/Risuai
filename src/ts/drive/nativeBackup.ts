import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type BackupProgress = { id: number, done: number, total: number }

function encodeName(name: string): string {
    let binary = ''
    for (const byte of new TextEncoder().encode(name)) {
        binary += String.fromCharCode(byte)
    }
    return btoa(binary)
}

/**
 * Writes a local backup through Rust commands (src-tauri/src/backup.rs) on Tauri.
 * Produces the same file format as LocalWriter.writeBackup, but streams assets from disk
 * in Rust instead of moving each one through the webview.
 */
export class NativeBackupWriter {
    private id: number | null = null

    /** Opens a save dialog and the target file. Resolves to false if cancelled. */
    async init(): Promise<boolean> {
        this.id = await invoke<number | null>('backup_open')
        return this.id !== null
    }

    private requireId(): number {
        if (this.id === null) {
            throw new Error('Backup is not open')
        }
        return this.id
    }

    /**
     * Writes `.png` assets from the assets folder.
     * @param only file names without the `assets/` prefix, or null for every asset
     * @returns missing file names without the `assets/` prefix
     */
    async writeAssets(only: string[] | null, onProgress: (done: number, total: number) => void) {
        const id = this.requireId()
        const unlisten = await listen<BackupProgress>('backup_progress', (event) => {
            if (event.payload.id === id) {
                onProgress(event.payload.done, event.payload.total)
            }
        })
        try {
            return await this.guard(invoke<{ written: number, missing: string[] }>('backup_write_assets', { id, only }))
        } finally {
            unlisten()
        }
    }

    async writeBackup(name: string, data: Uint8Array): Promise<void> {
        const id = this.requireId()
        await this.guard(invoke('backup_write_entry', data, {
            headers: {
                'x-risu-backup-id': String(id),
                'x-risu-backup-name': encodeName(name),
            }
        }))
    }

    async close(): Promise<void> {
        const id = this.requireId()
        this.id = null
        await invoke('backup_close', { id, discard: false })
    }

    /** Deletes the partly written backup when a write fails, then rethrows. */
    private async guard<T>(promise: Promise<T>): Promise<T> {
        try {
            return await promise
        } catch (error) {
            if (this.id !== null) {
                const id = this.id
                this.id = null
                await invoke('backup_close', { id, discard: true }).catch(() => {})
            }
            throw error
        }
    }
}
