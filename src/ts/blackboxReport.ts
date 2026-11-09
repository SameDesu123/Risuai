import { changeLanguage, language } from "src/lang"
import { alertConfirm, alertNormal, doingAlert } from "./alert"
import { getBlackboxReports, markBlackboxReportsNotified } from "./blackbox"
import { downloadFile } from "./globalApi.svelte"
import { sleep } from "./util"

const LANGUAGE_KEY = 'risu_blackbox_lang'
const PROMPT_LANGUAGES = ['de', 'en', 'es', 'ko', 'cn', 'vi', 'zh-Hant']

/**
 * Remembers the UI language, so the crash prompt can use it before the save is loaded.
 */
export function rememberBlackboxLanguage(lang: string | undefined) {
    try {
        if (lang) {
            localStorage.setItem(LANGUAGE_KEY, lang)
        }
    } catch { }
}

/**
 * The prompt runs before the save (and its language setting) is loaded.
 * Use the language remembered from the last session, else the browser's.
 * Loading the save calls changeLanguage again, so this does not stick.
 */
function applyPromptLanguage() {
    let lang: string | null = null
    try {
        lang = localStorage.getItem(LANGUAGE_KEY)
    } catch { }
    if (!lang) {
        const browser = navigator.language ?? ''
        lang = browser === 'zh-TW' || browser === 'zh-HK' ? 'zh-Hant'
            : browser.startsWith('zh') ? 'cn'
            : browser.split('-')[0]
    }
    if (PROMPT_LANGUAGES.includes(lang)) {
        changeLanguage(lang)
    }
}

/**
 * Asks the user to export new crash reports, if the last session crashed while visible.
 * Called during startup, before the save is loaded.
 * Sessions that were killed in the background are kept silently: mobile browsers do
 * that routinely, and asking every time would be noise. They can still be exported
 * from the settings.
 */
export async function promptBlackboxReports() {
    const pending = getBlackboxReports().filter((r) => !r.notified && r.verdict === 'crashed-while-visible')
    if (pending.length === 0) {
        return
    }
    // Mark first, so a crash during the prompt does not ask again forever
    markBlackboxReportsNotified()
    while (doingAlert()) {
        await sleep(500)
    }
    applyPromptLanguage()
    if (await alertConfirm(language.crashReportDetected)) {
        await exportBlackboxReports()
    }
}

export async function exportBlackboxReports() {
    const reports = getBlackboxReports()
    if (reports.length === 0) {
        alertNormal(language.noCrashReports)
        return
    }
    const now = new Date()
    const payload = {
        generator: 'risuai-blackbox',
        exportedAt: now.toISOString(),
        reports,
    }
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    await downloadFile(`risu-crash-report-${stamp}.json`, JSON.stringify(payload, null, 2))
}
