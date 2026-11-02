import { BaseDirectory, readFile, readDir, writeFile } from "@tauri-apps/plugin-fs";
import localforage from "localforage";
import { alertError, alertNormal, alertStore, alertWait, alertMd } from "../alert";
import { LocalWriter, forageStorage, requiresFullEncoderReload } from "../globalApi.svelte";
import { isTauri } from "src/ts/platform"
import { decodeRisuSave, encodeRisuSave } from "../storage/risuSave";
import { saveKV, saveKVSourceFromData, type SaveKVSource } from "../storage/saveKV";
import { getDatabase, saveCurrentPreset, setDatabaseLite, setPreset, type Database } from "../storage/database.svelte";
import { relaunch } from "@tauri-apps/plugin-process";
import { decryptBuffer, encryptBuffer, sleep } from "../util";
import { hubURL } from "../characterCards";
import { collectColdStorageBackupPayloads, confirmIncompleteColdStorageOperation, getColdStorageBackupKey, getColdStorageItem, isColdStorageBackupData, isValidColdStorageItem, listColdDataKeys, listPluginStorageColdKeys, pluginStorage, setColdStorageItem } from "../process/coldstorage.svelte";
import { getPluginStorageIndexPointer } from "../process/coldstorageData";
import { DBState } from "../stores.svelte";
import {
    collectLocalBackupAssets,
    createLocalBackupManifest,
    includesWholeDatabase,
    isFullLocalBackup,
    localBackupDatabaseName,
    localBackupManifestName,
    localBackupSections,
    localBackupSelectiveDatabaseName,
    mergeLocalBackup,
    normalizeLocalBackupSections,
    parseLocalBackupManifest,
    toLocalBackupDatabase,
    type BackupAssetLabel,
    type LocalBackupSection,
} from "./backuplocalData";

function getBasename(data:string){
    const baseNameRegex = /\\/g
    const splited = data.replace(baseNameRegex, '/').split('/')
    const lasts = splited[splited.length-1]
    return lasts
}

/**
 * Saves a local backup of the selected sections (everything by default). Every backup is loaded with LoadLocalBackup.
 * @see LocalBackupSection
 */
export async function SaveLocalBackup(sections: Iterable<LocalBackupSection> = localBackupSections){
    const selected = new Set(normalizeLocalBackupSections(sections))
    if(selected.size === 0){
        return
    }
    if(isFullLocalBackup(selected)){
        return await saveFullLocalBackup()
    }
    return await saveSelectiveLocalBackup(selected)
}

function describeSkippedAssets(missingAssets: string[], assetMap: Map<string, BackupAssetLabel>){
    return missingAssets.map(key => {
        const assetInfo = assetMap.get(key);
        return assetInfo ? `'${assetInfo.assetName}' from ${assetInfo.charName}` : `'${key}'`;
    }).join(', ');
}

/**
 * Writes the assets listed in assetMap to the backup.
 * @returns the assets that could not be read and were skipped
 */
async function writeReferencedAssets(writer: LocalWriter, assetMap: Map<string, BackupAssetLabel>, progressLabel: string){
    const missingAssets: string[] = []
    const assetKeys = Array.from(assetMap.keys())

    for(let i=0;i<assetKeys.length;i++){
        const key = assetKeys[i]
        let message = `${progressLabel}... (${i + 1} / ${assetKeys.length})`
        if (missingAssets.length > 0) {
            message += `\n(Skipping... ${describeSkippedAssets(missingAssets, assetMap)})`;
        }
        alertWait(message)

        let data: Uint8Array | undefined;
        let fetchedFromServer = false;
        try {
            if(isTauri){
                data = await readFile(key, {baseDir: BaseDirectory.AppData})
            }
            else{
                if(forageStorage.isAccount && key.startsWith('assets/')){
                    const cached = await localforage.getItem(key) as ArrayBuffer;
                    if(cached) {
                        data = new Uint8Array(cached);
                    }
                }
                if (!data) {
                    fetchedFromServer = forageStorage.isAccount
                    data = await forageStorage.getItem(key) as unknown as Uint8Array
                }
            }
        } catch (error) {
            console.error(`Failed to read asset ${key} for backup:`, error)
        }

        if (data) {
            await writer.writeBackup(key, data)
        } else {
            missingAssets.push(key)
        }
        if(fetchedFromServer){
            await sleep(100)
        }
    }

    return missingAssets
}

async function writeColdStoragePayloads(writer: LocalWriter, payloads: { backupName: string, encoded: Uint8Array }[], progressLabel: string){
    for(let i=0;i<payloads.length;i++){
        const payload = payloads[i]
        alertWait(`${progressLabel}... (${i + 1} / ${payloads.length})`)
        await writer.writeBackup(payload.backupName, payload.encoded)
    }
}

/**
 * Encodes the database for a backup. On risuai.xyz an encrypted database is returned
 * (and the encryption metadata is written to the backup) when encrypt is set.
 */
async function encodeBackupDatabase(writer: LocalWriter, db: Database, encrypt: boolean, kv: SaveKVSource | null = saveKV){
    let dbData = await encodeRisuSave(db, { compression: true, kv })

    if(encrypt && location.origin.endsWith('risuai.xyz')){
        const time = Date.now()
        const key = (await (await fetch(`https://sv.risuai.xyz/cryptokey?key=${time}`)).json()).key
        const encrypted = await encryptBuffer(dbData, key)
        await writer.writeBackup('encryption.risudat', new TextEncoder().encode(JSON.stringify({ time, type: 'account' })))
        dbData = new Uint8Array(encrypted)
    }

    return dbData
}

function alertBackupResult(missingAssets: string[], assetMap: Map<string, BackupAssetLabel>, missingHeader: string){
    if (missingAssets.length > 0) {
        let message = `${missingHeader}\n\n`
        for (const key of missingAssets) {
            const assetInfo = assetMap.get(key)
            if (assetInfo) {
                message += `* **${assetInfo.assetName}** (from *${assetInfo.charName}*)  \n  *File: ${key}*\n`
            } else {
                message += `* **Unknown Asset**  \n  *File: ${key}*\n`
            }
        }
        alertMd(message)
    } else {
        alertNormal('Success')
    }
}

async function saveFullLocalBackup(){
    alertWait("Saving local backup...")
    const db = getDatabase()
    const coldStoragePayloads = await collectColdStorageBackupPayloads(db)
    const unavailableColdStorageKeys = [...coldStoragePayloads.missingKeys, ...coldStoragePayloads.invalidKeys]
    if(!await confirmIncompleteColdStorageOperation(db, unavailableColdStorageKeys, 'backup')){
        return
    }

    const writer = new LocalWriter()
    const r = await writer.init()
    if(!r){
        alertError('Failed')
        return
    }

    const assetMap = new Map<string, { charName: string, assetName: string }>()
    if (db.characters) {
        for (const char of db.characters) {
            if (!char) continue
            const charName = char.name ?? 'Unknown Character'
            
            if (char.image) assetMap.set(char.image, { charName: charName, assetName: 'Main Image' })
            
            if (char.emotionImages) {
                for (const em of char.emotionImages) {
                    if (em && em[1]) assetMap.set(em[1], { charName: charName, assetName: em[0] })
                }
            }
            if (char.type !== 'group') {
                if (char.additionalAssets) {
                    for (const em of char.additionalAssets) {
                        if (em && em[1]) assetMap.set(em[1], { charName: charName, assetName: em[0] })
                    }
                }
                if (char.vits) {
                    const keys = Object.keys(char.vits.files)
                    for (const key of keys) {
                        const vit = char.vits.files[key]
                        if (vit) assetMap.set(vit, { charName: charName, assetName: key })
                    }
                }
                if (char.ccAssets) {
                    for (const asset of char.ccAssets) {
                        if (asset && asset.uri) assetMap.set(asset.uri, { charName: charName, assetName: asset.name })
                    }
                }
            }
        }
    }
    if (db.userIcon) {
        assetMap.set(db.userIcon, { charName: 'User Settings', assetName: 'User Icon' })
    }
    if (db.customBackground) {
        assetMap.set(db.customBackground, { charName: 'User Settings', assetName: 'Custom Background' })
    }
    const missingAssets: string[] = []

    if(isTauri){
        const assets = await readDir('assets', {baseDir: BaseDirectory.AppData})
        let i = 0;
        for(let asset of assets){
            i += 1;
            let message = `Saving local Backup... (${i} / ${assets.length})`
            if (missingAssets.length > 0) {
                message += `\n(Skipping... ${describeSkippedAssets(missingAssets, assetMap)})`;
            }
            alertWait(message)

            const key = asset.name
            if(!key || !key.endsWith('.png')){
                continue
            }
            const data = await readFile('assets/' + asset.name, {baseDir: BaseDirectory.AppData})
            if (data) {
                await writer.writeBackup(key, data)
            } else {
                missingAssets.push(key)
            }
        }
    }
    else{
        const keys = await forageStorage.keys()

        for(let i=0;i<keys.length;i++){
            const key = keys[i]
            let message = `Saving local Backup... (${i + 1} / ${keys.length})`
            if (missingAssets.length > 0) {
                message += `\n(Skipping... ${describeSkippedAssets(missingAssets, assetMap)})`;
            }
            alertWait(message)

            if(!key || !key.endsWith('.png')){
                continue
            }
            let data: Uint8Array | undefined;
            let isCached = false;
            if(forageStorage.isAccount && key.startsWith('assets/')){
                if(DBState.db.skipSavingAssetsOnWebSync){
                    continue
                }

                const cached = await localforage.getItem(key) as ArrayBuffer;
                if(cached) {
                    isCached = true;
                    data = new Uint8Array(cached);
                }
            }
            
            if (!data) {
                data = await forageStorage.getItem(key) as unknown as Uint8Array
            }

            if (data) {
                await writer.writeBackup(key, data)
            } else {
                missingAssets.push(key)
            }
            if(forageStorage.isAccount && !isCached){
                await sleep(1000)
            }
        }
    }

    await writeColdStoragePayloads(writer, coldStoragePayloads.payloads, 'Saving local Backup Cold data')

    const dbWithoutAccount = { ...db, account: undefined }
    const dbData = await encodeBackupDatabase(writer, dbWithoutAccount, true)

    alertWait(`Saving local Backup... (Saving database)`)

    await writer.writeBackup(localBackupDatabaseName, dbData)
    await writer.close()

    alertBackupResult(missingAssets, assetMap, 'Backup Successful, but the following assets were missing and skipped:')
}

/** Writes the values of the active prompt preset, which are kept in the top level fields, back into the preset list. */
function syncActivePreset(){
    const db = getDatabase()
    if(!db.botPresets?.[db.botPresetsId]){
        return
    }
    try {
        saveCurrentPreset()
    } catch (error) {
        console.error('Failed to save the active preset before backup:', error)
    }
}

/** Loads the values of the active prompt preset of db into its top level fields. */
function applyActivePreset(db: Database){
    const preset = db.botPresets?.[db.botPresetsId]
    if(!preset){
        return
    }
    try {
        setPreset(db, preset)
    } catch (error) {
        console.error('Failed to apply the active preset of the restored backup:', error)
    }
}

/**
 * Saves a backup of the selected sections only, with the asset files they reference.
 *
 * With the whole database selected, its database replaces the current one on restore like a full backup.
 * Otherwise it is stored as localBackupSelectiveDatabaseName together with a manifest of the sections,
 * and restoring it applies only those sections on top of the current data (see mergeLocalBackup).
 */
async function saveSelectiveLocalBackup(sections: ReadonlySet<LocalBackupSection>){
    alertWait("Saving local backup...")
    if(sections.has('presets')){
        //without other settings, changes of the active preset would be lost: they are only in the top level fields
        syncActivePreset()
    }
    //collectColdStorageBackupPayloads only flushes plugin storage for the live database,
    //and the database pointer has to refer to an index containing the latest plugin storage changes
    await pluginStorage.flush().catch((error) => {
        console.error('Failed to save plugin storage before backup:', error)
    })
    const db = getDatabase()
    const backupDb = toLocalBackupDatabase(db, sections)
    //only chats of included characters and the storage of included plugins are collected
    const coldStoragePayloads = await collectColdStorageBackupPayloads(backupDb)
    const unavailableColdStorageKeys = [...coldStoragePayloads.missingKeys, ...coldStoragePayloads.invalidKeys]
    if(!await confirmIncompleteColdStorageOperation(backupDb, unavailableColdStorageKeys, 'backup')){
        return
    }

    const writer = new LocalWriter()
    const r = await writer.init()
    if(!r){
        alertError('Failed')
        return
    }

    //assets are collected from the live database: character images can be backed up without the characters
    const assetMap = collectLocalBackupAssets(db, sections)
    const missingAssets = await writeReferencedAssets(writer, assetMap, 'Saving local Backup')

    await writeColdStoragePayloads(writer, coldStoragePayloads.payloads, 'Saving local Backup Cold data')

    const dbData = await encodeBackupDatabase(writer, backupDb, true, sections.has('otherSettings') ? saveKV : null)

    alertWait(`Saving local Backup... (Saving database)`)

    if(includesWholeDatabase(sections)){
        await writer.writeBackup(localBackupDatabaseName, dbData)
    }
    else{
        await writer.writeBackup(localBackupManifestName, new TextEncoder().encode(createLocalBackupManifest(sections)))
        await writer.writeBackup(localBackupSelectiveDatabaseName, dbData)
    }
    await writer.close()

    alertBackupResult(missingAssets, assetMap, 'Backup Successful, but the following assets were missing and skipped:')
}

export function LoadLocalBackup(){
    try {
        const input = document.createElement('input');
        const encryptionMeta:{
            type: 'none' | 'account';
            time?: number;
        } = {
            type: 'none'
        }
        input.type = 'file';
        input.accept = '.bin';
        input.onchange = async () => {
            if (!input.files || input.files.length === 0) {
                input.remove();
                return;
            }
            const file = input.files[0];
            input.remove();

            const reader = file.stream().getReader();
            const CHUNK_SIZE = 1024 * 1024; // 1MB chunk size
            let bytesRead = 0;
            let remainingBuffer = new Uint8Array();
            let pendingDatabase: Uint8Array | null = null;
            //a selective backup is applied on top of the current database instead of replacing it
            let isSelectiveBackup = false;
            let selectiveBackupSections: Set<LocalBackupSection> | null = null;
            const restoredColdStorageKeys = new Set<string>();
            //items that don't look like character/chat data may be pluginStorage values,
            //which can only be identified once the database (written last) is decoded
            const pendingPluginColdStorage = new Map<string, unknown>();

            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }

                bytesRead += value.length;
                const progress = ((bytesRead / file.size) * 100).toFixed(2);
                alertWait(`Loading local Backup... (${progress}%)`);

                const newBuffer = new Uint8Array(remainingBuffer.length + value.length);
                newBuffer.set(remainingBuffer);
                newBuffer.set(value, remainingBuffer.length);
                remainingBuffer = newBuffer;

                let offset = 0;
                while (offset + 4 <= remainingBuffer.length) {
                    const nameLength = new Uint32Array(remainingBuffer.slice(offset, offset + 4).buffer)[0];

                    if (offset + 4 + nameLength > remainingBuffer.length) {
                        break;
                    }
                    const nameBuffer = remainingBuffer.slice(offset + 4, offset + 4 + nameLength);
                    const name = new TextDecoder().decode(nameBuffer);

                    if (offset + 4 + nameLength + 4 > remainingBuffer.length) {
                        break;
                    }
                    const dataLength = new Uint32Array(remainingBuffer.slice(offset + 4 + nameLength, offset + 4 + nameLength + 4).buffer)[0];

                    if (offset + 4 + nameLength + 4 + dataLength > remainingBuffer.length) {
                        break;
                    }
                    const data = remainingBuffer.slice(offset + 4 + nameLength + 4, offset + 4 + nameLength + 4 + dataLength);

                    if( name === 'encryption.risudat') {
                        try {
                            const meta = JSON.parse(new TextDecoder().decode(data)) as typeof encryptionMeta
                            if (meta.type === 'account' && meta.time) {
                                encryptionMeta.type = 'account'
                                encryptionMeta.time = meta.time
                            } else {
                                alertError('Invalid encryption metadata, will attempt to load database backup without decryption.')
                            }
                        } catch (e) {
                            console.error('Failed to parse encryption metadata:', e)
                            alertError('Failed to parse encryption metadata, will attempt to load database backup without decryption.')
                        }
                    }

                    else if (name === localBackupManifestName) {
                        selectiveBackupSections = parseLocalBackupManifest(new TextDecoder().decode(data));
                    }

                    else if (name === localBackupDatabaseName || name === localBackupSelectiveDatabaseName) {
                        pendingDatabase = new Uint8Array(data);
                        isSelectiveBackup = name === localBackupSelectiveDatabaseName;
                    }
                    
                    else {
                        const coldStorageKey = getColdStorageBackupKey(name)
                        let handledAsColdStorage = false

                        if (coldStorageKey) {
                            handledAsColdStorage = true
                            try {
                                const text = new TextDecoder().decode(data)
                                const jsonData = JSON.parse(text)

                                if (isColdStorageBackupData(jsonData)) {
                                    if(await setColdStorageItem(coldStorageKey, jsonData)){
                                        restoredColdStorageKeys.add(coldStorageKey)
                                    } else {
                                        console.error(`Failed to restore cold storage item ${coldStorageKey}`)
                                    }
                                } else {
                                    pendingPluginColdStorage.set(coldStorageKey, jsonData)
                                }
                            } catch (e) {
                                console.error(`Failed to parse cold storage item ${coldStorageKey}:`, e)
                            }
                        }

                        if (!handledAsColdStorage) {
                            if (isTauri) {
                                await writeFile(`assets/` + name, data, { baseDir: BaseDirectory.AppData });
                            } else {
                                await forageStorage.setItem('assets/' + name, data);
                            }
                        }
                    }
                    await sleep(10);
                    if (forageStorage.isAccount) {
                        await sleep(1000);
                    }

                    offset += 4 + nameLength + 4 + dataLength;
                }
                remainingBuffer = remainingBuffer.slice(offset);
            }

            //without its manifest, it is unknown which parts of a selective backup can be applied
            if(!pendingDatabase || (isSelectiveBackup && !selectiveBackupSections)){
                alertError('Failed, Is file corrupted?')
                return
            }

            let db = pendingDatabase;
            if(encryptionMeta.type === 'account' && encryptionMeta.time){
                try {
                    const key = (await (await fetch(`https://sv.risuai.xyz/cryptokey?key=${encryptionMeta.time}`)).json()).key
                    const decrypted = await decryptBuffer(db, key)
                    db = new Uint8Array(decrypted)
                }
                catch (e) {
                    console.error('Failed to decrypt database backup:', e)
                    alertError('Failed to decrypt database backup, will attempt to load it without decryption.')
                }
            }
            //cold storage is checked against the backup itself: a selective backup only brings the chats and plugin storage
            //of its own sections, and the data it keeps is not part of the restore
            const { database: dbData, kv: kvData } = await decodeRisuSave(db);
            const restorePendingPluginItem = async (key: string) => {
                if(!pendingPluginColdStorage.has(key)){
                    return
                }
                const value = pendingPluginColdStorage.get(key)
                pendingPluginColdStorage.delete(key)
                if(await setColdStorageItem(key, value)){
                    restoredColdStorageKeys.add(key)
                } else {
                    console.error(`Failed to restore cold storage item ${key}`)
                }
            }
            //the plugin storage index has to be restored first: it lists the large plugin storage items
            const pluginStorageIndex = getPluginStorageIndexPointer(dbData)
            if(pluginStorageIndex){
                await restorePendingPluginItem(pluginStorageIndex)
            }
            const legacyPluginStorageKeys = new Set(listPluginStorageColdKeys(dbData))
            const pluginStorageColdKeys = new Set([
                ...legacyPluginStorageKeys,
                ...await pluginStorage.referencedIds(dbData.pluginCustomStorage)
            ])
            for(const key of Array.from(pendingPluginColdStorage.keys())){
                if(!pluginStorageColdKeys.has(key)){
                    console.warn(`Skipping invalid cold storage backup item ${key}`)
                    continue
                }
                await restorePendingPluginItem(key)
            }
            const missingColdStorageKeys:string[] = []
            for(const key of await listColdDataKeys(dbData)){
                if(restoredColdStorageKeys.has(key)){
                    continue
                }
                const isPluginStorage = pluginStorageColdKeys.has(key)
                let existingColdStorage = await getColdStorageItem(key)
                if(legacyPluginStorageKeys.has(key)){
                    //legacy per-key items may hold null
                    existingColdStorage ??= null
                } else {
                    existingColdStorage ??= undefined
                }
                if(!isValidColdStorageItem(existingColdStorage, isPluginStorage)){
                    missingColdStorageKeys.push(key)
                }
            }
            if(!await confirmIncompleteColdStorageOperation(dbData, missingColdStorageKeys, 'restore')){
                return
            }

            let restoredDb = dbData;
            let restoredData = db;
            //KV data belongs to the other settings, like every database field without a section
            let restoreKV = true;
            if(isSelectiveBackup && selectiveBackupSections){
                alertWait('Loading local Backup... (Applying backup)');
                restoreKV = selectiveBackupSections.has('otherSettings');
                if(selectiveBackupSections.has('presets') !== selectiveBackupSections.has('otherSettings')){
                    //the kept preset list has to contain the latest values of the active preset
                    syncActivePreset();
                }
                restoredDb = mergeLocalBackup(dbData, getDatabase(), selectiveBackupSections, applyActivePreset);
                restoredData = await encodeRisuSave(restoredDb, {
                    compression: true,
                    kv: restoreKV ? saveKVSourceFromData(kvData) : saveKV
                });
            }

            setDatabaseLite(restoredDb);
            if(restoreKV){
                saveKV.load(kvData);
            }
            requiresFullEncoderReload.state = true;
            if (isTauri) {
                await writeFile('database/database.bin', restoredData, { baseDir: BaseDirectory.AppData });
                await relaunch();
                alertStore.set({
                    type: "wait",
                    msg: "Success, Refreshing your app."
                });
            } else {
                await forageStorage.setItem('database/database.bin', restoredData);
                location.search = '';
                alertStore.set({
                    type: "wait",
                    msg: "Success, Refreshing your app."
                });
            }

            alertNormal('Success');
        };

        input.click();
    } catch (error) {
        console.error(error);
        alertError('Failed, Is file corrupted?')
    }
}
