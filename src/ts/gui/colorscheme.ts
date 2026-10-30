import { get, writable } from "svelte/store";
import { getDatabase, setDatabase } from "../storage/database.svelte";
import { downloadFile } from "../globalApi.svelte";
import { BufferToText, selectSingleFile } from "../util";
import { alertError } from "../alert";
import { isLite } from "../lite";
import { CustomCSSStore, DBState, SafeModeStore } from "../stores.svelte";

import {
    colorSchemeList,
    colorSchemePresets,
    defaultColorScheme,
    textThemePresets,
    type ColorScheme,
} from "./colorschemePresets";

export { colorSchemeList, colorSchemePresets, defaultColorScheme, textThemePresets, type ColorScheme }

const colorShemes = colorSchemePresets

export const ColorSchemeTypeStore = writable('dark' as 'dark'|'light')

export function changeColorScheme(colorScheme: string){
    try {
        if(colorScheme === 'custom'){
            DBState.db.colorScheme = safeStructuredClone(DBState.db.customColorScheme ?? defaultColorScheme)
        }
        else{
            DBState.db.colorScheme = safeStructuredClone(colorShemes[colorScheme])
        }
        DBState.db.colorSchemeName = colorScheme
        updateColorScheme()   
    } catch (error) {}
}

export function updateCustomColorScheme(){
    try {
        DBState.db.colorScheme = safeStructuredClone(DBState.db.customColorScheme ?? defaultColorScheme)
        DBState.db.colorSchemeName = 'custom'
        updateColorScheme()
    } catch (error) {}
}

export function updateColorScheme(){
    try {
        let db = getDatabase()

        let colorScheme = db.colorScheme

        if(colorScheme == null){
            colorScheme = safeStructuredClone(defaultColorScheme)
        }

        if(get(isLite)){
            colorScheme = safeStructuredClone(colorShemes.lite)
        }

        //set css variables
        document.documentElement.style.setProperty("--risu-theme-bgcolor", colorScheme.bgcolor);
        document.documentElement.style.setProperty("--risu-theme-darkbg", colorScheme.darkbg);
        document.documentElement.style.setProperty("--risu-theme-borderc", colorScheme.borderc);
        document.documentElement.style.setProperty("--risu-theme-selected", colorScheme.selected);
        document.documentElement.style.setProperty("--risu-theme-draculared", colorScheme.draculared);
        document.documentElement.style.setProperty("--risu-theme-textcolor", colorScheme.textcolor);
        document.documentElement.style.setProperty("--risu-theme-textcolor2", colorScheme.textcolor2);
        document.documentElement.style.setProperty("--risu-theme-darkborderc", colorScheme.darkBorderc);
        document.documentElement.style.setProperty("--risu-theme-darkbutton", colorScheme.darkbutton);
        ColorSchemeTypeStore.set(colorScheme.type)
    } catch (error) {}
}

export function changeColorSchemeType(type: 'light'|'dark'){
    try {
        DBState.db.customColorScheme.type = type
        updateCustomColorScheme()
        updateTextThemeAndCSS()
    } catch (error) {}
}

export function exportColorScheme(){
    let json = JSON.stringify(DBState.db.customColorScheme)
    downloadFile('colorScheme.json', json)
}

export async function importColorScheme(){
    const uarray = await selectSingleFile(['json'])
    if(uarray == null){
        return
    }
    const string = BufferToText(uarray.data)
    let colorScheme: ColorScheme
    try{
        colorScheme = JSON.parse(string)
        if(
            typeof colorScheme.bgcolor !== 'string' ||
            typeof colorScheme.darkbg !== 'string' ||
            typeof colorScheme.borderc !== 'string' ||
            typeof colorScheme.selected !== 'string' ||
            typeof colorScheme.draculared !== 'string' ||
            typeof colorScheme.textcolor !== 'string' ||
            typeof colorScheme.textcolor2 !== 'string' ||
            typeof colorScheme.darkBorderc !== 'string' ||
            typeof colorScheme.darkbutton !== 'string' ||
            typeof colorScheme.type !== 'string'
        ){
            alertError('Invalid color scheme')
            return
        }
        DBState.db.customColorScheme = colorScheme
        updateCustomColorScheme()
    }
    catch(e){
        alertError('Invalid color scheme')
        return
    
    }
}

export function updateTextThemeAndCSS(){
    let db = DBState.db
    const root = document.querySelector(':root') as HTMLElement;
    if(!root){
        return
    }
    let textTheme = get(isLite) ? 'standard' : db.textTheme
    let colorScheme = get(isLite) ? 'dark' : db.colorScheme.type
    switch(textTheme){
        case "standard":
        case "highcontrast":{
            const palette = textThemePresets[textTheme][colorScheme === 'dark' ? 'dark' : 'light']
            for(const [role, color] of Object.entries(palette)){
                root.style.setProperty(`--${role}`, color);
            }
            break
        }
        case "custom":{
            root.style.setProperty('--FontColorStandard', db.customTextTheme.FontColorStandard);
            root.style.setProperty('--FontColorItalic', db.customTextTheme.FontColorItalic);
            root.style.setProperty('--FontColorBold', db.customTextTheme.FontColorBold);
            root.style.setProperty('--FontColorItalicBold', db.customTextTheme.FontColorItalicBold);
            root.style.setProperty('--FontColorQuote1', db.customTextTheme.FontColorQuote1 ?? '#8BE9FD');
            root.style.setProperty('--FontColorQuote2', db.customTextTheme.FontColorQuote2 ?? '#FFB86C');
            break
        }
    }

    switch(db.font){
        case "default":{
            root.style.setProperty('--risu-font-family', 'Arial, sans-serif');
            break
        }
        case "timesnewroman":{
            root.style.setProperty('--risu-font-family', 'Times New Roman, serif');
            break
        }
        case "custom":{
            root.style.setProperty('--risu-font-family', db.customFont);
            break
        }
    }

    if(!get(SafeModeStore)){
        CustomCSSStore.set(db.customCSS ?? '')
    }
    else{
        CustomCSSStore.set('')
    }
}
