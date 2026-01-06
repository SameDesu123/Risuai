import type { SettingItem } from './types';
import { guiSizeText, updateGuisize } from 'src/ts/gui/guisize';
import { updateAnimationSpeed } from 'src/ts/gui/animation';
import { changeFullscreen } from 'src/ts/util';

// Theme Tab (submenu === 0)
// Most theme items are kept inline due to complex conditional UI and dynamic select options
export const displayThemeItems: SettingItem[] = [
    // ColorSchemeEditor custom component handles custom color scheme UI
    { type: 'custom', id: 'disp.colorSchemeEditor', componentId: 'ColorSchemeEditor' },
    // TextThemeEditor custom component handles custom text theme UI
    { type: 'custom', id: 'disp.textThemeEditor', componentId: 'TextThemeEditor' },
];

// Size and Speed Tab (submenu === 1)
export const displaySizeSpeedItems: SettingItem[] = [
    {
        id: 'disp.zoomsize', type: 'slider', labelKey: 'UISize', bindKey: 'zoomsize',
        options: { min: 50, max: 200 }
    },
    {
        id: 'disp.lineHeight', type: 'slider', labelKey: 'lineHeight', bindKey: 'lineHeight',
        options: { min: 0.5, max: 3, step: 0.05, fixed: 2 }
    },
    {
        id: 'disp.iconsize', type: 'slider', labelKey: 'iconSize', bindKey: 'iconsize',
        options: { min: 50, max: 200 }
    },
    {
        id: 'disp.textAreaSize', type: 'slider', labelKey: 'textAreaSize', bindKey: 'textAreaSize',
        options: { 
            min: -5, max: 5,
            customText: (value) => guiSizeText(value),
            onchange: updateGuisize
        }
    },
    {
        id: 'disp.textAreaTextSize', type: 'slider', labelKey: 'textAreaTextSize', bindKey: 'textAreaTextSize',
        options: { 
            min: 0, max: 3,
            customText: (value) => guiSizeText(value),
            onchange: updateGuisize
        }
    },
    {
        id: 'disp.sideBarSize', type: 'slider', labelKey: 'sideBarSize', bindKey: 'sideBarSize',
        options: { 
            min: 0, max: 3,
            customText: (value) => guiSizeText(value),
            onchange: updateGuisize
        }
    },
    {
        id: 'disp.assetWidth', type: 'slider', labelKey: 'assetWidth', bindKey: 'assetWidth',
        options: { 
            min: -1, max: 40, step: 1,
            customText: (value) => 
                value === -1 ? "Unlimited" : 
                value === 0 ? "Hidden" : `${value.toFixed(1)} rem`
        }
    },
    {
        id: 'disp.animationSpeed', type: 'slider', labelKey: 'animationSpeed', bindKey: 'animationSpeed',
        options: { 
            min: 0, max: 1, step: 0.05, fixed: 2,
            onchange: updateAnimationSpeed
        }
    },
    {
        id: 'disp.memoryLimitThickness', type: 'slider', labelKey: 'memoryLimitThickness', bindKey: 'memoryLimitThickness',
        options: { min: 1, max: 500, step: 1 },
        condition: (ctx) => ctx.db.showMemoryLimit
    },
    {
        id: 'disp.settingsCloseButtonSize', type: 'slider', labelKey: 'settingsCloseButtonSize', bindKey: 'settingsCloseButtonSize',
        helpKey: 'settingsCloseButtonSize',
        options: { min: 16, max: 48, step: 1 }
    },
];

// Others Tab (submenu === 2)
export const displayOthersItems: SettingItem[] = [
    // Fullscreen with onchange handler
    { 
        id: 'disp.fullScreen', type: 'check', labelKey: 'fullscreen', bindKey: 'fullScreen',
        options: { onchange: changeFullscreen }
    },
    { id: 'disp.showMemoryLimit', type: 'check', labelKey: 'showMemoryLimit', bindKey: 'showMemoryLimit' },
    { id: 'disp.showFirstMessagePages', type: 'check', labelKey: 'showFirstMessagePages', bindKey: 'showFirstMessagePages' },
    { id: 'disp.hideRealm', type: 'check', labelKey: 'hideRealm', bindKey: 'hideRealm' },
    { id: 'disp.hideAllImages', type: 'check', labelKey: 'hideAllImages', bindKey: 'hideAllImages', helpKey: 'hideAllImagesDesc' },
    { id: 'disp.showFolderName', type: 'check', labelKey: 'showFolderNameInIcon', bindKey: 'showFolderName' },

    // Custom background check with file picker
    { type: 'custom', id: 'disp.customBackground', componentId: 'CustomBackgroundCheck' },

    { id: 'disp.playMessage', type: 'check', labelKey: 'playMessage', bindKey: 'playMessage', helpKey: 'msgSound' },
    { id: 'disp.playMessageOnTranslateEnd', type: 'check', labelKey: 'playMessageOnTranslateEnd', bindKey: 'playMessageOnTranslateEnd' },
    { id: 'disp.roundIcons', type: 'check', labelKey: 'roundIcons', bindKey: 'roundIcons' },

    // Color toggle checks
    {
        type: 'custom', id: 'disp.textScreenColor', componentId: 'ColorToggleCheck',
        componentProps: { bindKey: 'textScreenColor', labelKey: 'textBackgrounds' }
    },

    { id: 'disp.textBorder', type: 'check', labelKey: 'textBorder', bindKey: 'textBorder' },
    { id: 'disp.textScreenRounded', type: 'check', labelKey: 'textScreenRound', bindKey: 'textScreenRounded' },
    { id: 'disp.showSavingIcon', type: 'check', labelKey: 'showSavingIcon', bindKey: 'showSavingIcon' },
    { id: 'disp.showPromptComparison', type: 'check', labelKey: 'showPromptComparison', bindKey: 'showPromptComparison' },

    {
        type: 'custom', id: 'disp.textScreenBorder', componentId: 'ColorToggleCheck',
        componentProps: { bindKey: 'textScreenBorder', labelKey: 'textScreenBorder' }
    },

    { id: 'disp.useChatCopy', type: 'check', labelKey: 'useChatCopy', bindKey: 'useChatCopy' },
    { id: 'disp.useAdditionalAssetsPreview', type: 'check', labelKey: 'useAdditionalAssetsPreview', bindKey: 'useAdditionalAssetsPreview' },
    { id: 'disp.useLegacyGUI', type: 'check', labelKey: 'useLegacyGUI', bindKey: 'useLegacyGUI' },
    { id: 'disp.hideApiKey', type: 'check', labelKey: 'hideApiKeys', bindKey: 'hideApiKey' },
    { id: 'disp.unformatQuotes', type: 'check', labelKey: 'unformatQuotes', bindKey: 'unformatQuotes' },
    { id: 'disp.customQuotes', type: 'check', labelKey: 'customQuotes', bindKey: 'customQuotes' },
    { id: 'disp.betaMobileGUI', type: 'check', labelKey: 'betaMobileGUI', bindKey: 'betaMobileGUI', helpKey: 'betaMobileGUI' },
    { id: 'disp.menuSideBar', type: 'check', labelKey: 'menuSideBar', bindKey: 'menuSideBar' },

    // Notification with permission request
    { type: 'custom', id: 'disp.notification', componentId: 'NotificationCheck' },

    // Chat sticker (unrecommended, conditional)
    {
        id: 'disp.useChatSticker', type: 'check', labelKey: 'useChatSticker', bindKey: 'useChatSticker',
        helpKey: 'unrecommended', helpUnrecommended: true,
        condition: (ctx) => ctx.db.showUnrecommended
    },
];
