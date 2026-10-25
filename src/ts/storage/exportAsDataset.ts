import { getDatabase } from "./database.svelte";
import { downloadFile } from "../globalApi.svelte";
import { alertError, alertNormal } from "../alert";
import { language } from "src/lang";
import { getColdStorageItem, loadColdChatForExport } from "../process/coldstorage.svelte";

export async function exportAsDataset(){
    const db = getDatabase()

    let dataset = []
    for(let char of db.characters){
        if(char.type === 'group'){
            continue
        }
        if(char.coldstorage){
            //cold characters only keep a stub, so read the full character
            let coldData = null
            try {
                coldData = await getColdStorageItem(char.coldstorage)
            } catch (error) {
                console.error(error)
            }
            if(!coldData?.character || coldData.character.chaId !== char.chaId){
                alertError(`${language.errors.coldStorageRestoreFailed} (${char.name})`)
                return
            }
            char = coldData.character
            if(char.type === 'group'){
                continue
            }
        }
        for(let i=0;i<char.chats.length;i++){
            //chats not opened since they were frozen are still in cold storage
            const chat = await loadColdChatForExport(char.chats[i])
            if(!chat){
                alertError(language.errors.coldStorageExportFailed(char.chats[i].name || `Chat ${i + 1}`))
                return
            }
            
            dataset.push({
                name: char.name,
                description: char.desc,
                chats: chat.message,
                lorebook: char.globalLore
            })
        }
    }

    await downloadFile('dataset.json',Buffer.from(JSON.stringify(dataset, null,4), 'utf-8'))

    alertNormal(language.successExport)
    
}
