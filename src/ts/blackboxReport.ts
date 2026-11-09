import { language } from "src/lang"
import { alertConfirm, alertNormal, doingAlert } from "./alert"
import { getBlackboxReports, markBlackboxReportsNotified } from "./blackbox"
import { downloadFile } from "./globalApi.svelte"
import { sleep } from "./util"

/**
 * Asks the user to export new crash reports, if the last session crashed while visible.
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
