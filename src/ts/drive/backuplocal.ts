import { BaseDirectory, readFile, readDir, writeFile } from "@tauri-apps/plugin-fs";
import localforage from "localforage";
import { alertError, alertNormal, alertStore, alertWait, alertMd, alertConfirm } from "../alert";
import { LocalWriter, forageStorage, requiresFullEncoderReload } from "../globalApi.svelte";
import { isTauri } from "src/ts/platform"
import { decodeRisuSave, encodeRisuSave } from "../storage/risuSave";
import { saveKV, saveKVSourceFromData } from "../storage/saveKV";
import { getDatabase, setDatabaseLite, type Database } from "../storage/database.svelte";
import { relaunch } from "@tauri-apps/plugin-process";
import { decryptBuffer, encryptBuffer, sleep } from "../util";
import { hubURL } from "../characterCards";
import { language } from "src/lang";
import { collectColdStorageBackupPayloads, confirmIncompleteColdStorageOperation, getColdStorageBackupKey, getColdStorageItem, isColdStorageBackupData, isValidColdStorageItem, listColdDataKeys, listPluginStorageColdKeys, pluginStorage, setColdStorageItem } from "../process/coldstorage.svelte";
import { getPluginStorageIndexPointer } from "../process/coldstorageData";
import { DBState } from "../stores.svelte";
import { collectSettingsBackupAssets, localBackupDatabaseName, localBackupSettingsDatabaseName, mergeSettingsBackup, toSettingsBackupDatabase, type BackupAssetLabel, type LocalBackupMode } from "./backuplocalData";

function getBasename(data:string){
    const baseNameRegex = /\\/g
    const splited = data.replace(baseNameRegex, '/').split('/')
    const lasts = splited[splited.length-1]
    return lasts
}

/**
 * Saves a local backup of the given kind. Every kind is loaded back with LoadLocalBackup.
 * @see LocalBackupMode
 */
export async function SaveLocalBackup(mode: LocalBackupMode = 'full'){
    switch(mode){
        case 'partial':
            return await savePartialLocalBackup()
        case 'settings':
            return await saveSettingsLocalBackup()
        default:
            return await saveFullLocalBackup()
    }
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
async function encodeBackupDatabase(writer: LocalWriter, db: Database, encrypt: boolean){
    let dbData = await encodeRisuSave(db, { compression: true, kv: saveKV })

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

/**
 * Saves a partial local backup with only critical assets.
 * 
 * Differences from the full backup:
 * - Only includes profile images for characters/groups (excludes emotion images, additional assets, VITS files, CC assets)
 * - Additionally includes: persona icons, folder images, bot preset images
 * - Processes only assets in assetMap (selective) instead of all .png files in assets folder
 * - Faster and more efficient for quick backups
 * - Ideal for backing up core visual identity without bulk data
 */
async function savePartialLocalBackup(){
    // First confirmation: Explain the difference from regular backup
    const firstConfirm = await alertConfirm(language.partialBackupFirstConfirm)
    
    if (!firstConfirm) {
        return
    }
    
    // Second confirmation: Final warning about not saving assets
    const secondConfirm = await alertConfirm(language.partialBackupSecondConfirm)
    
    if (!secondConfirm) {
        return
    }
    
    alertWait("Saving partial local backup...")
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
    
    // Only collect main profile images for both characters and groups
    if (db.characters) {
        for (const char of db.characters) {
            if (!char) continue
            const charName = char.name ?? 'Unknown Character'
            
            // Save the main profile image (supports both character and group types)
            // Note: emotionImages are intentionally excluded from partial backup
            if (char.image) {
                assetMap.set(char.image, { charName: charName, assetName: 'Profile Image' })
            }
        }
    }
    
    // User icon
    if (db.userIcon) {
        assetMap.set(db.userIcon, { charName: 'User Settings', assetName: 'User Icon' })
    }
    
    // Persona icons
    if (db.personas) {
        for (const persona of db.personas) {
            if (persona && persona.icon) {
                assetMap.set(persona.icon, { charName: 'Persona', assetName: `${persona.name} Icon` })
            }
        }
    }
    
    // Custom background
    if (db.customBackground) {
        assetMap.set(db.customBackground, { charName: 'User Settings', assetName: 'Custom Background' })
    }
    
    // Folder images in characterOrder
    if (db.characterOrder) {
        for (const item of db.characterOrder) {
            if (typeof item !== 'string' && item.img) {
                assetMap.set(item.img, { charName: 'Folder', assetName: `${item.name} Folder Image` })
            }
            if (typeof item !== 'string' && item.imgFile) {
                assetMap.set(item.imgFile, { charName: 'Folder', assetName: `${item.name} Folder Image File` })
            }
        }
    }
    
    // Bot preset images
    if (db.botPresets) {
        for (const preset of db.botPresets) {
            if (preset && preset.image) {
                assetMap.set(preset.image, { charName: 'Preset', assetName: `${preset.name} Preset Image` })
            }
        }
    }
    
    // Like before, only PNG assets are part of a partial backup
    const pngAssetMap = new Map(Array.from(assetMap).filter(([key]) => key.endsWith('.png')))
    const missingAssets = await writeReferencedAssets(writer, pngAssetMap, 'Saving partial local backup')

    await writeColdStoragePayloads(writer, coldStoragePayloads.payloads, 'Saving partial local Backup Cold data')

    const dbWithoutAccount = { ...db, account: undefined }
    const dbData = await encodeBackupDatabase(writer, dbWithoutAccount, false)

    alertWait(`Saving partial local backup... (Saving database)`) 

    await writer.writeBackup(localBackupDatabaseName, dbData)
    await writer.close()

    alertBackupResult(missingAssets, pngAssetMap, 'Partial backup successful, but the following profile images were missing and skipped:')
}

/**
 * Saves a backup of everything except characters (with their chats), the character order and the account:
 * settings, prompts, presets, personas, modules (with their assets), plugins and plugin storage.
 *
 * Loading it keeps the current characters and replaces everything else (see mergeSettingsBackup).
 * Its database is stored as localBackupSettingsDatabaseName, so older versions refuse to load it
 * instead of replacing the database with one without characters.
 */
async function saveSettingsLocalBackup(){
    alertWait("Saving settings backup...")
    const db = getDatabase()

    //collectColdStorageBackupPayloads only flushes plugin storage for the live database,
    //and the database pointer has to refer to an index containing the latest plugin storage changes
    await pluginStorage.flush().catch((error) => {
        console.error('Failed to save plugin storage before backup:', error)
    })
    const settingsDb = toSettingsBackupDatabase(db)
    //without characters, only plugin storage is collected from cold storage
    const coldStoragePayloads = await collectColdStorageBackupPayloads(settingsDb)
    const unavailableColdStorageKeys = [...coldStoragePayloads.missingKeys, ...coldStoragePayloads.invalidKeys]
    if(!await confirmIncompleteColdStorageOperation(settingsDb, unavailableColdStorageKeys, 'backup')){
        return
    }

    const writer = new LocalWriter()
    const r = await writer.init()
    if(!r){
        alertError('Failed')
        return
    }

    const assetMap = collectSettingsBackupAssets(settingsDb)
    const missingAssets = await writeReferencedAssets(writer, assetMap, 'Saving settings backup')

    await writeColdStoragePayloads(writer, coldStoragePayloads.payloads, 'Saving settings backup Cold data')

    const dbData = await encodeBackupDatabase(writer, settingsDb, true)

    alertWait(`Saving settings backup... (Saving database)`)

    await writer.writeBackup(localBackupSettingsDatabaseName, dbData)
    await writer.close()

    alertBackupResult(missingAssets, assetMap, 'Settings backup successful, but the following assets were missing and skipped:')
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
            //a settings backup is merged into the current database instead of replacing it
            let isSettingsBackup = false;
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

                    else if (name === localBackupDatabaseName || name === localBackupSettingsDatabaseName) {
                        pendingDatabase = new Uint8Array(data);
                        isSettingsBackup = name === localBackupSettingsDatabaseName;
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

            if(!pendingDatabase){
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
            //cold storage is checked against the backup itself: a settings backup only brings plugin storage,
            //and the characters it keeps are not part of the restore
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
            if(isSettingsBackup){
                alertWait('Loading local Backup... (Applying settings)');
                restoredDb = mergeSettingsBackup(dbData, getDatabase());
                restoredData = await encodeRisuSave(restoredDb, { compression: true, kv: saveKVSourceFromData(kvData) });
            }

            setDatabaseLite(restoredDb);
            saveKV.load(kvData);
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
