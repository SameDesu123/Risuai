/**
 * risuSaveServer.cjs
 * 
 * Node.js CJS version of RisuSave encoder/decoder
 * Ported risuSave.ts logic from client to server side
 */

const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

// Magic headers
const magicRisuSaveHeader = Buffer.from('RISUSAVE\0');

// Block types (enum from risuSave.ts)
const RisuSaveType = {
    CONFIG: 0,
    ROOT: 1,
    CHARACTERWITHCHAT: 2,
    CHAT: 3,
    BOTPRESET: 4,
    MODULES: 5
};

/**
 * Decode database.bin file into block map
 * @param {Buffer} data - database.bin file data
 * @returns {Promise<Map<string, { type: number, compression: boolean, content: string, raw: Buffer }>>}
 */
async function decodeBlocks(data) {
    const blocks = new Map();
    
    // Verify header
    if (!data.subarray(0, magicRisuSaveHeader.length).equals(magicRisuSaveHeader)) {
        throw new Error('Invalid RISUSAVE header');
    }
    
    let offset = magicRisuSaveHeader.length;
    
    while (offset < data.length) {
        const type = data[offset];
        const compression = data[offset + 1] === 1;
        offset += 2;
        
        const nameLength = data[offset];
        offset += 1;
        
        const name = data.subarray(offset, offset + nameLength).toString('utf-8');
        offset += nameLength;
        
        const length = data.readUInt32LE(offset);
        offset += 4;
        
        let blockData = data.subarray(offset, offset + length);
        offset += length;
        
        // Also store raw block data (can be reused without re-encoding)
        const rawBlockStart = offset - length - 4 - nameLength - 1 - 2;
        const rawBlock = data.subarray(rawBlockStart, offset);
        
        let content;
        if (compression) {
            try {
                const decompressed = await gunzip(blockData);
                content = decompressed.toString('utf-8');
            } catch (error) {
                console.error(`Error decompressing block ${name}:`, error);
                continue;
            }
        } else {
            content = blockData.toString('utf-8');
        }
        
        blocks.set(name, {
            type,
            compression,
            content,
            raw: rawBlock
        });
    }
    
    return blocks;
}

/**
 * Encode a single block
 * @param {{ type: number, compression: boolean, data: string, name: string }} arg
 * @returns {Promise<Buffer>}
 */
async function encodeBlock(arg) {
    let databuf;
    
    if (arg.compression) {
        databuf = await gzip(Buffer.from(arg.data, 'utf-8'));
    } else {
        databuf = Buffer.from(arg.data, 'utf-8');
    }
    
    const nameBuf = Buffer.from(arg.name, 'utf-8');
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32LE(databuf.length);
    
    // [type: 1byte] [compression: 1byte] [nameLength: 1byte] [name] [dataLength: 4bytes] [data]
    const totalLength = 2 + 1 + nameBuf.length + 4 + databuf.length;
    const result = Buffer.alloc(totalLength);
    
    result[0] = arg.type;
    result[1] = arg.compression ? 1 : 0;
    result[2] = nameBuf.length;
    nameBuf.copy(result, 3);
    lengthBuf.copy(result, 3 + nameBuf.length);
    databuf.copy(result, 7 + nameBuf.length);
    
    return result;
}

/**
 * Encode block map into database.bin format
 * @param {Map<string, Buffer>} blocks - Block name -> encoded block data
 * @returns {Buffer}
 */
function encodeBlocks(blocks) {
    let totalLength = magicRisuSaveHeader.length;
    
    for (const [name, blockData] of blocks) {
        totalLength += blockData.length;
    }
    
    const result = Buffer.alloc(totalLength);
    let offset = 0;
    
    magicRisuSaveHeader.copy(result, offset);
    offset += magicRisuSaveHeader.length;
    
    for (const [name, blockData] of blocks) {
        blockData.copy(result, offset);
        offset += blockData.length;
    }
    
    return result;
}

/**
 * Apply changed blocks to existing database.bin and return new database.bin
 * @param {Buffer} existingData - Existing database.bin data
 * @param {{ [name: string]: string }} changedBlocks - Changed blocks (name -> base64 encoded block data)
 * @param {string[]} deletedBlocks - Array of deleted block names
 * @param {boolean} compression - Whether to apply compression to new blocks
 * @returns {Promise<Buffer>}
 */
async function mergeBlocks(existingData, changedBlocks, deletedBlocks = [], compression = false) {
    // 1. Decode existing blocks
    const blocks = await decodeBlocks(existingData);
    
    console.log(`[sync-blocks] Existing blocks: ${blocks.size}`);
    console.log(`[sync-blocks] Changed blocks: ${Object.keys(changedBlocks).length}`);
    console.log(`[sync-blocks] Deleted blocks: ${deletedBlocks.length}`);
    
    // 2. Remove deleted blocks
    for (const name of deletedBlocks) {
        blocks.delete(name);
        console.log(`[sync-blocks] Deleted block: ${name}`);
    }
    
    // 3. Apply changed blocks
    // changedBlocks is already encoded block data (base64)
    for (const [name, base64Data] of Object.entries(changedBlocks)) {
        const blockBuffer = Buffer.from(base64Data, 'base64');
        
        // Extract type from block header
        const type = blockBuffer[0];
        const blockCompression = blockBuffer[1] === 1;
        
        blocks.set(name, {
            type,
            compression: blockCompression,
            content: '', // Not used when re-encoding
            raw: blockBuffer
        });
        console.log(`[sync-blocks] Updated block: ${name} (type: ${type})`);
    }
    
    // 4. Reassemble blocks with raw data
    const rawBlocks = new Map();
    for (const [name, block] of blocks) {
        rawBlocks.set(name, block.raw);
    }
    
    // 5. Encode into database.bin format
    return encodeBlocks(rawBlocks);
}

/**
 * List block names only
 * @param {Buffer} data - database.bin data
 * @returns {Promise<string[]>}
 */
async function listBlockNames(data) {
    const blocks = await decodeBlocks(data);
    return Array.from(blocks.keys());
}

module.exports = {
    RisuSaveType,
    decodeBlocks,
    encodeBlock,
    encodeBlocks,
    mergeBlocks,
    listBlockNames,
    magicRisuSaveHeader
};
