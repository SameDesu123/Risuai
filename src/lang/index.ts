import merge from "lodash/merge";
import { languageChinese } from "./cn";
import { languageGerman } from "./de";
import { languageEnglish } from "./en";
import { languageKorean } from "./ko";
import { languageVietnamese } from "./vi";
import { languageChineseTraditional } from "./zh-Hant";
import { languageSpanish } from "./es";

export let language:typeof languageEnglish = languageEnglish

const LAST_LANGUAGE_KEY = 'risu_last_language'
const supportedLanguages = ['cn', 'de', 'en', 'es', 'ko', 'vi', 'zh-Hant']

/**
 * Applies a language before the save file is loaded: the language the save last used
 * on this device, or the browser language. setDatabase() replaces it with the saved one.
 */
export function applyPreloadLanguage(){
    let lang: string | null = null
    try {
        lang = localStorage.getItem(LAST_LANGUAGE_KEY)
    } catch {}
    if(!lang && typeof navigator !== 'undefined'){
        const browserLang = navigator.language ?? ''
        const short = browserLang.split('-')[0]
        if(browserLang === 'zh-TW' || browserLang === 'zh-HK' || browserLang.startsWith('zh-Hant')){
            lang = 'zh-Hant'
        }
        else if(short === 'zh'){
            lang = 'cn'
        }
        else{
            lang = short
        }
    }
    setLanguage(supportedLanguages.includes(lang) ? lang : 'en')
}

export function changeLanguage(lang:string){
    setLanguage(lang)
    try {
        localStorage.setItem(LAST_LANGUAGE_KEY, lang)
    } catch {}
}

function setLanguage(lang:string){
    if(lang === 'cn'){
        language = merge(safeStructuredClone(languageEnglish), languageChinese)
    }
    else if(lang === 'de'){
        language = merge(safeStructuredClone(languageEnglish), languageGerman)
    }
    else if(lang === 'ko'){
        language = merge(safeStructuredClone(languageEnglish), languageKorean)
    }
    else if(lang === 'vi'){
        language = merge(safeStructuredClone(languageEnglish), languageVietnamese)
    }
    else if(lang === 'zh-Hant'){
        language = merge(safeStructuredClone(languageEnglish), languageChineseTraditional)
    }
    else if(lang === 'es'){
        language = merge(safeStructuredClone(languageEnglish), languageSpanish)
    }
    else{
        language = languageEnglish
    }
}