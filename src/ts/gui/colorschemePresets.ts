// Built-in color scheme and text theme presets.
// Kept free of imports so tests can load them without pulling in the app.

export interface ColorScheme{
    bgcolor: string;
    darkbg: string;
    borderc: string;
    selected: string;
    draculared: string;
    textcolor: string;
    textcolor2: string;
    darkBorderc: string;
    darkbutton: string;
    type:'light'|'dark';
}


export const defaultColorScheme: ColorScheme = {
    bgcolor: "#282a36",
    darkbg: "#21222c",
    borderc: "#6272a4",
    selected: "#44475a",
    draculared: "#ff5555",
    textcolor: "#f8f8f2",
    textcolor2: "#64748b",
    darkBorderc: "#4b5563",
    darkbutton: "#374151",
    type:'dark'
}

const colorShemes = {
    "default": defaultColorScheme,
    "dark": {
        bgcolor: "#1a1a1a",
        darkbg: "#141414",
        borderc: "#525252",
        selected: "#3d3d3d",
        draculared: "#ff5555",
        textcolor: "#f5f5f5",
        textcolor2: "#a3a3a3",
        darkBorderc: "#404040",
        darkbutton: "#2e2e2e",
        type:'dark'
    },
    "light": {
        bgcolor: "#ffffff",
        darkbg: "#f0f0f0",
        borderc: "#0f172a",
        selected: "#e0e0e0",
        draculared: "#ff5555",
        textcolor: "#0f172a",
        textcolor2: "#64748b",
        darkBorderc: "#d1d5db",
        darkbutton: "#e5e7eb",
        type:'light'
    },
    "cherry": {
        bgcolor: "#450a0a",
        darkbg: "#7f1d1d",
        borderc: "#ea580c",
        selected: "#d97706",
        draculared: "#ff5555",
        textcolor: "#f8f8f2",
        textcolor2: "#fca5a5",
        darkBorderc: "#92400e",
        darkbutton: "#b45309",
        type:'dark'
    },
    "galaxy": {
        bgcolor: "#0f172a",
        darkbg: "#1f2a48",
        borderc: "#8be9fd",
        selected: "#457b9d",
        draculared: "#ff5555",
        textcolor: "#f8f8f2",
        textcolor2: "#8be9fd",
        darkBorderc: "#457b9d",
        darkbutton: "#1f2a48",
        type:'dark'
    },
    "nature": {
        bgcolor: "#1b4332",
        darkbg: "#2d6a4f",
        borderc: "#a8dadc",
        selected: "#4d908e",
        draculared: "#ff5555",
        textcolor: "#f8f8f2",
        textcolor2: "#4d908e",
        darkBorderc: "#457b9d",
        darkbutton: "#2d6a4f",
        type:'dark'
    },
    "ocean": {
        bgcolor: "#0b1f2a",
        darkbg: "#08202b",
        borderc: "#38bdf8",
        selected: "#164e63",
        draculared: "#fb7185",
        textcolor: "#e6f6fb",
        textcolor2: "#8fc7d5",
        darkBorderc: "#155e75",
        darkbutton: "#0f3a4a",
        type:'dark'
    },
    "aurora": {
        bgcolor: "#10201c",
        darkbg: "#152a24",
        borderc: "#5eead4",
        selected: "#315c52",
        draculared: "#fb7185",
        textcolor: "#ecfdf5",
        textcolor2: "#a7f3d0",
        darkBorderc: "#2f6f63",
        darkbutton: "#21443c",
        type:'dark'
    },
    "twilight": {
        bgcolor: "#171324",
        darkbg: "#201936",
        borderc: "#c084fc",
        selected: "#3b2a5a",
        draculared: "#f43f5e",
        textcolor: "#f8f5ff",
        textcolor2: "#c4b5fd",
        darkBorderc: "#4c3575",
        darkbutton: "#2e2348",
        type:'dark'
    },
    "realblack": {
        bgcolor: "#000000",
        darkbg: "#000000",
        borderc: "#6272a4",
        selected: "#44475a",
        draculared: "#ff5555",
        textcolor: "#f8f8f2",
        textcolor2: "#64748b",
        darkBorderc: "#4b5563",
        darkbutton: "#374151",
        type:'dark'
    },
    "monokai-light": {
        bgcolor: "#f8f8f2",
        darkbg: "#e8e8e3",
        borderc: "#75715e",
        selected: "#d8d8d0",
        draculared: "#f92672",
        textcolor: "#272822",
        textcolor2: "#75715e",
        darkBorderc: "#c0c0b8",
        darkbutton: "#d0d0c8",
        type:'light'
    },
    "monokai-black": {
        bgcolor: "#272822",
        darkbg: "#1e1f1a",
        borderc: "#75715e",
        selected: "#3e3d32",
        draculared: "#f92672",
        textcolor: "#f8f8f2",
        textcolor2: "#a6a68a",
        darkBorderc: "#3e3d32",
        darkbutton: "#3e3d32",
        type:'dark'
    },
    "sky-light": {
        bgcolor: "#f6fbff",
        darkbg: "#e8f3fb",
        borderc: "#0284c7",
        selected: "#d7ecf8",
        draculared: "#e11d48",
        textcolor: "#0f172a",
        textcolor2: "#516174",
        darkBorderc: "#b7d7ea",
        darkbutton: "#dbeafe",
        type:'light'
    },
    "sage-light": {
        bgcolor: "#f7faf5",
        darkbg: "#e8f0e6",
        borderc: "#3f6212",
        selected: "#d9e8d3",
        draculared: "#dc2626",
        textcolor: "#1f2933",
        textcolor2: "#586a52",
        darkBorderc: "#b7c9ad",
        darkbutton: "#dce8d6",
        type:'light'
    },
    "lavender-light": {
        bgcolor: "#f8f7ff",
        darkbg: "#ede9fe",
        borderc: "#6d28d9",
        selected: "#ddd6fe",
        draculared: "#e11d48",
        textcolor: "#1e1b4b",
        textcolor2: "#5b5680",
        darkBorderc: "#c4b5fd",
        darkbutton: "#e0e7ff",
        type:'light'
    },
    "slate-light": {
        bgcolor: "#f8fafc",
        darkbg: "#e2e8f0",
        borderc: "#334155",
        selected: "#cbd5e1",
        draculared: "#dc2626",
        textcolor: "#020617",
        textcolor2: "#475569",
        darkBorderc: "#94a3b8",
        darkbutton: "#cbd5e1",
        type:'light'
    },
    "lite": {
        bgcolor: "#1f2937",
        darkbg: "#1C2533",
        borderc: "#475569",
        selected: "#475569",
        draculared: "#ff5555",
        textcolor: "#f8f8f2",
        textcolor2: "#64748b",
        darkBorderc: "#030712",
        darkbutton: "#374151",
        type:'dark'
    }

} as const

export const colorSchemePresets = colorShemes

export const colorSchemeList = Object.keys(colorShemes) as (keyof typeof colorShemes)[]

export type TextThemeRole =
    | 'FontColorStandard'
    | 'FontColorItalic'
    | 'FontColorBold'
    | 'FontColorItalicBold'
    | 'FontColorQuote1'
    | 'FontColorQuote2'

export type TextThemePalette = Record<TextThemeRole, string>

export const textThemePresets: Record<'standard'|'highcontrast', Record<'dark'|'light', TextThemePalette>> = {
    standard: {
        dark: {
            FontColorStandard: '#fafafa',
            FontColorItalic: '#8C8D93',
            FontColorBold: '#fafafa',
            FontColorItalicBold: '#8C8D93',
            FontColorQuote1: '#8BE9FD',
            FontColorQuote2: '#FFB86C',
        },
        light: {
            FontColorStandard: '#0f172a',
            FontColorItalic: '#8C8D93',
            FontColorBold: '#0f172a',
            FontColorItalicBold: '#8C8D93',
            FontColorQuote1: '#8BE9FD',
            FontColorQuote2: '#FFB86C',
        },
    },
    highcontrast: {
        dark: {
            FontColorStandard: '#f8f8f2',
            FontColorItalic: '#F1FA8C',
            FontColorBold: '#8BE9FD',
            FontColorItalicBold: '#FFB86C',
            FontColorQuote1: '#8BE9FD',
            FontColorQuote2: '#FFB86C',
        },
        light: {
            FontColorStandard: '#0f172a',
            FontColorItalic: '#F1FA8C',
            FontColorBold: '#8BE9FD',
            FontColorItalicBold: '#FFB86C',
            FontColorQuote1: '#8BE9FD',
            FontColorQuote2: '#FFB86C',
        },
    },
}
