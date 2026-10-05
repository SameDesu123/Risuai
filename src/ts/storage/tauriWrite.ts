import { BaseDirectory, copyFile, rename, writeFile } from "@tauri-apps/plugin-fs"

// Every IPC request body is copied several times by WebView2 and the Tauri host, and wry reads it on the window's
// UI thread, so a file of tens of MB sent in one call spikes memory by gigabytes and freezes the window on Windows.
export const ipcWriteChunkSize = 8 * 1024 * 1024

/**
 * Replaces a file under AppData, sending the data over IPC in chunks of at most `chunkSize` bytes.
 * The chunks go to a temporary file that is then renamed over the target, so a write cut short
 * never leaves the target truncated (a truncated save file still decodes, without its last blocks).
 *
 * @param {string} path - The path of the file to replace, relative to AppData.
 * @param {Uint8Array} data - The new contents of the file.
 * @param {number} chunkSize - The largest number of bytes sent in one IPC call.
 */
export async function replaceFileInChunks(path: string, data: Uint8Array, chunkSize = ipcWriteChunkSize) {
    const tmpPath = `${path}.tmp`
    let offset = 0
    do {
        await writeFile(tmpPath, data.subarray(offset, offset + chunkSize), {
            baseDir: BaseDirectory.AppData,
            append: offset > 0
        })
        offset += chunkSize
    } while (offset < data.length)
    try {
        await rename(tmpPath, path, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData })
    } catch (error) {
        // e.g. another program holds the target open on Windows: overwrite it in place instead
        console.error(error)
        await copyFile(tmpPath, path, { fromPathBaseDir: BaseDirectory.AppData, toPathBaseDir: BaseDirectory.AppData })
    }
}
