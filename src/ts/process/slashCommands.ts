import { language } from "src/lang";
import { getDatabase, type character, type customscript, type groupChat } from "../storage/database.svelte";
import { risuChatParser } from "../parser/parser.svelte";
import { getModules } from "./modules";
import {
    getCommandFlag,
    getCommandNameFromInput,
    getFlagMetas,
    getRegexArgNames,
    getScriptRegexFlags,
    isValidCommandName,
} from "./slashCommandFlags";

export type SlashCommandSource = 'builtin' | 'preset' | 'character' | 'module'

export interface SlashCommandEntry {
    name: string
    usage: string
    description: string
    source: SlashCommandSource
    sourceName?: string
    script?: customscript
}

// Commands handled by processMultiCommand. /setinput and /multisend are left out on purpose:
// the former is not implemented and the latter is split apart by the pipe parser.
const builtinCommands:{name:string, usage:string, desc:keyof typeof language.slashCommandDesc}[] = [
    { name: 'input', usage: '/input [text]', desc: 'input' },
    { name: 'echo', usage: '/echo [text]', desc: 'echo' },
    { name: 'popup', usage: '/popup [text]', desc: 'popup' },
    { name: 'pass', usage: '/pass [text]', desc: 'pass' },
    { name: 'buttons', usage: '/buttons labels=["A","B"]', desc: 'buttons' },
    { name: 'speak', usage: '/speak [text]', desc: 'speak' },
    { name: 'send', usage: '/send [text]', desc: 'send' },
    { name: 'sendas', usage: '/sendas [text]', desc: 'sendas' },
    { name: 'comment', usage: '/comment [text]', desc: 'comment' },
    { name: 'cut', usage: '/cut [index | start-end]', desc: 'cut' },
    { name: 'del', usage: '/del [count]', desc: 'del' },
    { name: 'len', usage: '/len [JSON array]', desc: 'len' },
    { name: 'setvar', usage: '/setvar key=[name] [value]', desc: 'setvar' },
    { name: 'addvar', usage: '/addvar key=[name] [number]', desc: 'addvar' },
    { name: 'getvar', usage: '/getvar key=[name]', desc: 'getvar' },
    { name: 'test_lorebook', usage: '/test_lorebook', desc: 'test_lorebook' },
    { name: 'trigger', usage: '/trigger [name]', desc: 'trigger' },
    { name: '?', usage: '/?', desc: 'help' },
]

// Every name processMultiCommand reacts to, including the ones hidden from the list
const reservedNames = new Set([...builtinCommands.map((c) => c.name), 'setinput', 'multisend'])

export function isBuiltinCommandName(name:string){
    return reservedNames.has(name)
}

export function getBuiltinSlashCommands():SlashCommandEntry[]{
    return builtinCommands.map((c) => ({
        name: c.name,
        usage: c.usage,
        description: language.slashCommandDesc[c.desc],
        source: 'builtin',
    }))
}

function toCustomCommand(script:customscript, source:SlashCommandSource, sourceName?:string):SlashCommandEntry|null{
    if(script.type !== 'editinput' || !script.ableFlag || !script.in){
        return null
    }
    const name = getCommandFlag(script.flag)
    if(!name || !isValidCommandName(name) || isBuiltinCommandName(name)){
        return null
    }
    const args = getRegexArgNames(script.in).map((v) => `<${v}>`)
    return {
        name,
        usage: ['/' + name, ...args].join(' '),
        description: script.comment ?? '',
        source,
        sourceName,
        script,
    }
}

// Regex commands only run where editinput scripts run, which excludes group chats
export function getCustomSlashCommands(char:character|groupChat|undefined|null):SlashCommandEntry[]{
    if(!char || char.type === 'group'){
        return []
    }
    const db = getDatabase()
    const result:SlashCommandEntry[] = []
    const push = (scripts:customscript[]|undefined, source:SlashCommandSource, sourceName?:string) => {
        for(const script of scripts ?? []){
            const command = toCustomCommand(script, source, sourceName)
            if(command){
                result.push(command)
            }
        }
    }
    push(db.presetRegex, 'preset')
    push(char.customscript, 'character', char.name)
    for(const module of getModules()){
        if(module){
            push(module.regex, 'module', module.name)
        }
    }
    return result
}

export function getSlashCommands(char:character|groupChat|undefined|null):SlashCommandEntry[]{
    const seen = new Set<string>()
    const result:SlashCommandEntry[] = []
    for(const command of getBuiltinSlashCommands().concat(getCustomSlashCommands(char))){
        // Several scripts may share a name to handle different argument shapes; list it once
        const key = command.name.toLocaleLowerCase()
        if(seen.has(key)){
            continue
        }
        seen.add(key)
        result.push(command)
    }
    return result
}

export function filterSlashCommands(commands:SlashCommandEntry[], query:string){
    query = query.toLocaleLowerCase()
    const prefix:SlashCommandEntry[] = []
    const partial:SlashCommandEntry[] = []
    for(const command of commands){
        const name = command.name.toLocaleLowerCase()
        if(name.startsWith(query)){
            prefix.push(command)
        }
        else if(query && name.includes(query)){
            partial.push(command)
        }
    }
    return prefix.concat(partial)
}

export function findSlashCommand(commands:SlashCommandEntry[], name:string){
    const key = name.toLocaleLowerCase()
    return commands.find((c) => c.name.toLocaleLowerCase() === key) ?? null
}

function scriptMatches(script:customscript, input:string){
    let regexIn = script.in
    if(getFlagMetas(script.flag).includes('cbs')){
        regexIn = risuChatParser(regexIn)
    }
    try {
        const reg = new RegExp(regexIn, getScriptRegexFlags(script.flag, script.ableFlag))
        // CBS in the input is parsed before editinput runs. Parsing it here could run
        // side effects like {{setvar}} twice, so such input is let through unchecked.
        return reg.test(input) || input.includes('{{')
    } catch {
        // A broken pattern is the creator's problem; do not block sending over it
        return true
    }
}

// Returns the command whose IN rejected the input with the usage of every script sharing its name,
// or null when sending may continue
export function findSlashCommandMismatch(char:character|groupChat, input:string):{name:string, usages:string[]}|null{
    const name = getCommandNameFromInput(input)
    if(!name || isBuiltinCommandName(name)){
        return null
    }
    const key = name.toLocaleLowerCase()
    const candidates = getCustomSlashCommands(char).filter((c) => c.name.toLocaleLowerCase() === key)
    if(candidates.length === 0){
        return null
    }
    if(candidates.some((c) => scriptMatches(c.script, input))){
        return null
    }
    return {
        name: candidates[0].name,
        usages: [...new Set(candidates.map((c) => c.usage))],
    }
}
