import { alertConfirm, alertSelect } from "./alert";
import { applyPreloadLanguage, language } from "../lang";
import {
    check,
    type Update,
} from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { LoadingStatusState } from "./stores.svelte";

const UPDATE_REMINDER_KEY = 'risu_update_reminder'

interface UpdateReminder {
    until: number
}

function getUpdateReminder(): UpdateReminder | null {
    try {
        const stored = localStorage.getItem(UPDATE_REMINDER_KEY)
        if (stored) {
            return JSON.parse(stored)
        }
    } catch {
        // Ignore parse errors
    }
    return null
}

function setUpdateReminder(days: number): void {
    const until = Date.now() + days * 24 * 60 * 60 * 1000
    localStorage.setItem(UPDATE_REMINDER_KEY, JSON.stringify({ until }))
}

function clearUpdateReminder(): void {
    localStorage.removeItem(UPDATE_REMINDER_KEY)
}

function isUpdateReminderActive(): boolean {
    const reminder = getUpdateReminder()
    if (reminder && reminder.until > Date.now()) {
        return true
    }
    if (reminder) {
        clearUpdateReminder()
    }
    return false
}

/**
 * Downloads and installs the update while reporting progress to the loading screen.
 * The caller clears the progress state afterwards.
 */
async function installUpdateWithProgress(update: Update){
    LoadingStatusState.update = {
        version: update.version,
        phase: 'downloading',
        downloaded: 0,
        total: null,
    }
    await update.download((event) => {
        const progress = LoadingStatusState.update
        if (!progress) {
            return
        }
        switch (event.event) {
            case 'Started':
                // A missing or zero length means the size is unknown
                progress.total = event.data.contentLength || null
                progress.downloaded = 0
                break
            case 'Progress':
                progress.downloaded += event.data.chunkLength
                break
            case 'Finished':
                progress.phase = 'installing'
                break
        }
    })
    LoadingStatusState.update.phase = 'installing'
    await update.install()
}

/**
 * Checks for a desktop update at launch. Runs before the save file is loaded,
 * so it must not depend on the database. Never throws: failures are logged.
 */
export async function checkRisuUpdate(){
    try {
        const checked = await check()     
        if(checked){
            if (isUpdateReminderActive()) {
                return
            }

            // The save (and its language setting) is not loaded yet
            applyPreloadLanguage()
            const conf = await alertConfirm(language.newVersion)
            if(conf){
                clearUpdateReminder()
                await installUpdateWithProgress(checked)
                await relaunch()
            } else {
                const options = [
                    language.remindIgnore,
                    language.remindLater1Day,
                    language.remindLater3Days,
                    language.remindLater5Days,
                    language.remindLater1Week,
                ]
                
                const selected = await alertSelect(options, language.remindLaterQuestion)
                const selectedIndex = parseInt(selected)

                switch (selectedIndex) {
                    case 0:
                        break
                    case 1:
                        setUpdateReminder(1)
                        break
                    case 2:
                        setUpdateReminder(3)
                        break
                    case 3:
                        setUpdateReminder(5)
                        break
                    case 4:
                        setUpdateReminder(7)
                        break
                }
            }
        }
    } catch (error) {
        console.error(error)
    } finally {
        LoadingStatusState.update = null
    }
}

// Test function for web console
// @ts-ignore
if (typeof window !== 'undefined') {
    (window as any).testUpdateReminder = async () => {
        const conf = await alertConfirm(language.newVersion)
        if (conf) {
            console.log('User chose to install')
        } else {
            const options = [
                language.remindIgnore,
                language.remindLater1Day,
                language.remindLater3Days,
                language.remindLater5Days,
                language.remindLater1Week,
            ]
            
            const selected = await alertSelect(options, language.remindLaterQuestion)
            console.log('Selected index:', selected)
        }
    }
}

