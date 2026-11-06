import { get, writable } from "svelte/store"
import { language } from "../lang"
import { isTauri, isNodeServer } from "src/ts/platform"
import { getDatabase, type MessageGenerationInfo } from "./storage/database.svelte"
import { alertStore as alertStoreImported, openDialog, setStatusAlert, pushToast, waitForDialogs } from "./alertQueue"

export interface alertData{
    type: 'error'|'normal'|'none'|'ask'|'wait'|'selectChar'
            |'input'|'toast'|'wait2'|'markdown'|'select'|'login'
            |'tos'|'cardexport'|'requestdata'|'addchar'|'hypaV2'|'selectModule'
            |'chatOptions'|'pukmakkurit'|'branches'|'progress'|'pluginconfirm'|'requestlogs',
    msg: string,
    submsg?: string
    datalist?: [string, string][],
    stackTrace?: string;
    defaultValue?: string
}

type AlertGenerationInfoStoreData = {
    genInfo: MessageGenerationInfo,
    idx: number
}
export const alertGenerationInfoStore = writable<AlertGenerationInfoStoreData>(null)
export const alertStore = {
    set: (d:alertData) => {
        alertStoreImported.set(d)
    }
}

export function alertError(msg: string | Error) {
    console.error(msg)
    const db = getDatabase()

    let stackTrace: string | undefined = undefined; 

    if (typeof(msg) !== 'string') {
        try{
            if (msg instanceof Error) {
                stackTrace = msg.stack
                msg = msg.message
            } else {
                msg = JSON.stringify(msg)
            }
        } catch {
            msg = `${msg}`
        }
    }

    msg = msg.trim()

    const ignoredErrors = [
        '{}'
    ]

    if(ignoredErrors.includes(msg)){
        return
    }

    let submsg = ''

    //check if it's a known error
    if(msg.includes('Failed to fetch') || msg.includes("NetworkError when attempting to fetch resource.")){
        submsg =    db.usePlainFetch ? language.errors.networkFetchPlain :
                    (!isTauri && !isNodeServer) ? language.errors.networkFetchWeb : language.errors.networkFetch
    }

    void openDialog({
        'type': 'error',
        'msg': msg,
        'submsg': submsg,
        'stackTrace': stackTrace
    }, { replaceable: true })
}

export async function waitAlert(){
    await waitForDialogs()
}

export function alertNormal(msg:string){
    void openDialog({
        'type': 'normal',
        'msg': msg
    }, { replaceable: true })
}

export async function alertNormalWait(msg:string){
    await openDialog({
        'type': 'normal',
        'msg': msg
    })
}

export async function alertAddCharacter() {
    return await openDialog({
        'type': 'addchar',
        'msg': language.addCharacter
    })
}

export async function alertChatOptions() {
    const msg = await openDialog({
        'type': 'chatOptions',
        'msg': language.chatOptions
    })

    return parseInt(msg)
}

export async function alertLogin(){
    return await openDialog({
        'type': 'login',
        'msg': 'login'
    })
}

export async function alertSelect(msg:string[], display?:string){
    const message = display !== undefined ? `__DISPLAY__${display}||${msg.join('||')}` : msg.join('||')
    return await openDialog({
        'type': 'select',
        'msg': message
    })
}

export async function alertErrorWait(msg:string){
    await openDialog({
        'type': 'wait2',
        'msg': msg
    })
}

export function alertMd(msg:string){
    void openDialog({
        'type': 'markdown',
        'msg': msg
    }, { replaceable: true })
}

export function doingAlert(){
    return get(alertStoreImported).type !== 'none' && get(alertStoreImported).type !== 'toast' && get(alertStoreImported).type !== 'wait'
}

export function alertToast(msg:string){
    pushToast(msg)
}

export function alertWait(msg:string){
    setStatusAlert({
        'type': 'wait',
        'msg': msg
    })

}

/** Hides the wait/progress overlay. Open dialogs stay until the user answers them. */
export function alertClear(){
    setStatusAlert(null)
}

export async function alertSelectChar(){
    return await openDialog({
        'type': 'selectChar',
        'msg': ''
    })
}

export async function alertConfirm(msg:string){

    const answer = await openDialog({
        'type': 'ask',
        'msg': msg
    })

    return answer === 'yes'
}

export async function alertPluginConfirm(msg:string){

    const answer = await openDialog({
        'type': 'pluginconfirm',
        'msg': msg
    })

    return answer === 'yes'
}

export async function alertCardExport(type:string = ''){

    const answer = await openDialog({
        'type': 'cardexport',
        'msg': '',
        'submsg': type
    })

    return JSON.parse(answer) as {
        type: string,
        type2: string,
    }
}

export async function alertTOS(){

    if(localStorage.getItem('tos4') === 'true'){
        return true
    }

    const answer = await openDialog({
        'type': 'tos',
        'msg': 'tos'
    })

    if(answer === 'yes'){
        localStorage.setItem('tos4', 'true')
        return true
    }

    if(localStorage.getItem('tos2') && Date.now() - new Date('2026-05-15').getTime() < 0){
        //apply grace period until 2026-05-15 for users who accepted tos2
        return true
    }

    return false
}

export async function alertInput(msg:string, datalist?:[string, string][], defaultValue?:string) {

    return await openDialog({
        'type': 'input',
        'msg': msg,
        'datalist': datalist ?? [],
        'defaultValue': defaultValue ?? ''
    })
}

export async function alertModuleSelect(){

    return await openDialog({
        'type': 'selectModule',
        'msg': ''
    })
}

export function alertRequestData(info:AlertGenerationInfoStoreData){
    alertGenerationInfoStore.set(info)
    void openDialog({
        'type': 'requestdata',
        'msg': info.genInfo.generationId ?? 'none'
    })
}

export function showHypaV2Alert(){
    void openDialog({
        'type': 'hypaV2',
        'msg': ""
    })
}

export function alertRequestLogs(){
    void openDialog({
        'type': 'requestlogs',
        'msg': ''
    })
}
