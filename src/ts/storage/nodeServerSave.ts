import type { NodeStorage } from "./nodeStorage"
import type { RisuSaveEncoder } from "./risuSave"

export type NodeServerSaveOutcome =
    | 'saved'
    /** the encoder has no config block yet; try again later */
    | 'empty'
    /** the server has no /api/db/save; upload the whole file instead */
    | 'unsupported'

/**
 * Saves through the Node server's /api/db/save: only blocks changed since the last
 * acknowledged save are sent, and the server assembles database.bin, writes the backup
 * and prunes old backups. If the server lost that save (restart, or database.bin replaced
 * through /api/write), every block is sent once more.
 */
export async function saveDatabaseOnNodeServer(
    encoder: RisuSaveEncoder,
    storage: Pick<NodeStorage, 'saveDatabase'>
): Promise<NodeServerSaveOutcome> {
    for(let attempt = 0; attempt < 2; attempt++){
        const request = encoder.encodeServerSave()
        if(!request){
            return 'empty'
        }
        const result = await storage.saveDatabase(request.payload)
        if(result.status === 'saved'){
            request.commit(result.revision)
            console.log(`Saved on the server: sent ${request.sentBlocks} of ${request.totalBlocks} blocks`)
            return 'saved'
        }
        if(result.status === 'unsupported'){
            return 'unsupported'
        }
        encoder.resetServerSave()
    }
    //a full save has no base revision, so the server cannot call it stale
    throw new Error('The server rejected a full database save as out of date')
}
