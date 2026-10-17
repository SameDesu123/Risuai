import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { isTauri } from "../platform";

// Height of the band the traffic lights sit in; trafficLightPosition in src-tauri/tauri.macos.conf.json is tuned for it
const TITLEBAR_HEIGHT = '32px'

function detectOverlayTitlebar(){
    if(!isTauri){
        return false
    }
    try {
        return platform() === 'macos'
    } catch {
        return false
    }
}

// The macOS window uses titleBarStyle "Overlay", so the traffic lights are drawn over the webview
export const hasOverlayTitlebar = detectOverlayTitlebar()

export const TitlebarState = $state({
    // Whether the layout has to keep room for the traffic lights; macOS hides them in fullscreen
    inset: false
})

function applyInset(inset:boolean){
    TitlebarState.inset = inset
    document.documentElement.style.setProperty('--risu-titlebar-height', inset ? TITLEBAR_HEIGHT : '0px')
}

export async function initTitlebar(){
    if(!hasOverlayTitlebar){
        return
    }
    applyInset(true)
    const appWindow = getCurrentWindow()
    const update = async () => {
        applyInset(!(await appWindow.isFullscreen()))
    }
    let pendingCheck: ReturnType<typeof setTimeout> | undefined
    await appWindow.onResized(() => {
        // The window only reports leaving fullscreen once the exit animation is done, so check after resizing settles
        clearTimeout(pendingCheck)
        pendingCheck = setTimeout(update, 200)
    })
    await update()
}
