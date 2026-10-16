import { language } from "../../lang";

export interface ChatCommandInfo {
    name: string
    // argument placeholders, each shown as its own badge
    usage: string[]
    description: () => string
}

// Built-in slash commands handled by processCommand in ./command.ts
export const builtinCommands: ChatCommandInfo[] = [
    { name: 'input', usage: ['text'], description: () => language.chatCommands.input },
    { name: 'echo', usage: ['text'], description: () => language.chatCommands.echo },
    { name: 'popup', usage: ['text'], description: () => language.chatCommands.popup },
    { name: 'pass', usage: ['text'], description: () => language.chatCommands.pass },
    { name: 'buttons', usage: ['label', 'label...'], description: () => language.chatCommands.buttons },
    { name: 'speak', usage: ['text'], description: () => language.chatCommands.speak },
    { name: 'send', usage: ['text'], description: () => language.chatCommands.send },
    { name: 'sendas', usage: ['text'], description: () => language.chatCommands.sendas },
    { name: 'comment', usage: ['text'], description: () => language.chatCommands.comment },
    { name: 'cut', usage: ['index | start-end | chatId'], description: () => language.chatCommands.cut },
    { name: 'del', usage: ['count'], description: () => language.chatCommands.del },
    { name: 'len', usage: ['JSON array'], description: () => language.chatCommands.len },
    { name: 'multisend', usage: ['text|||text...'], description: () => language.chatCommands.multisend },
    { name: 'setvar', usage: ['key', 'value'], description: () => language.chatCommands.setvar },
    { name: 'addvar', usage: ['key', 'value'], description: () => language.chatCommands.addvar },
    { name: 'getvar', usage: ['key'], description: () => language.chatCommands.getvar },
    { name: 'trigger', usage: ['name'], description: () => language.chatCommands.trigger },
    { name: '?', usage: [], description: () => language.chatCommands.help },
]

export type CommandSectionId = 'builtin'

export interface CommandSection {
    id: CommandSectionId
    label: () => string
    commands: ChatCommandInfo[]
}

// Sections shown in the suggestion list, in display order
export function getCommandSections(): CommandSection[] {
    return [
        { id: 'builtin', label: () => language.chatCommandUI.builtin, commands: builtinCommands },
    ]
}

export interface CommandSuggestions {
    sections: CommandSection[]
    // index into the usage badges of the argument under the cursor, or null while the command name is being typed
    argIndex: number | null
}

// Returns the commands to show for the current input, or null when the list should not be shown.
// While the name is typed, every command starting with it is listed.
// Once arguments are typed, only the matching command stays, with the argument being typed marked.
export function getCommandSuggestions(input: string): CommandSuggestions | null {
    if(!input.startsWith('/')){
        return null
    }
    const nameEnd = input.search(/\s/)
    if(nameEnd === -1){
        const query = input.slice(1).toLowerCase()
        const sections = getCommandSections()
            .map((section) => ({ ...section, commands: section.commands.filter((c) => c.name.startsWith(query)) }))
            .filter((section) => section.commands.length > 0)
        return { sections, argIndex: null }
    }

    const name = input.slice(1, nameEnd).toLowerCase()
    const line = input.slice(nameEnd)
    // a pipe starts the next command, which this list does not follow yet
    if(hasUnquotedPipe(line)){
        return null
    }
    const sections = getCommandSections()
        .map((section) => ({ ...section, commands: section.commands.filter((c) => c.name === name) }))
        .filter((section) => section.commands.length > 0)
    const usageLength = sections[0]?.commands[0]?.usage.length ?? 0
    if(usageLength === 0){
        return { sections, argIndex: null }
    }
    // the marker lands in whichever argument the cursor is in, including a new one after a trailing space
    const tokens = tokenizeArgs(line.trimStart() + '\u0000')
    const typed = tokens.findIndex((token) => token.value.endsWith('\u0000'))
    // the last usage entry takes the rest of the line
    return { sections, argIndex: Math.min(typed, usageLength - 1) }
}

// Same quote rule processMultiCommand uses to split commands
function hasUnquotedPipe(text: string) {
    let inQuote = false
    for(const char of text){
        if(char === '"'){
            inQuote = !inQuote
        }
        else if(char === '|' && !inQuote){
            return true
        }
    }
    return false
}

export interface CommandToken {
    // argument text, without the quotes that grouped it
    value: string
    // offset of the argument in the argument line
    start: number
}

// Splits the argument line on whitespace.
// Double quotes group words into one argument, and nothing inside brackets is split,
// so JSON like ["a", "b"] and CBS like {{getvar::a b}} each stay one argument.
export function tokenizeArgs(line:string):CommandToken[]{
    const tokens:CommandToken[] = []
    let i = 0
    while(i < line.length){
        if(/\s/.test(line[i])){
            i++
            continue
        }
        const start = i
        let value = ''
        let inQuote = false
        let bracketDepth = 0
        for(; i < line.length; i++){
            const char = line[i]
            if(!inQuote && bracketDepth === 0 && /\s/.test(char)){
                break
            }
            if(char === '"' && bracketDepth === 0){
                inQuote = !inQuote
                continue
            }
            if(!inQuote){
                if(char === '[' || char === '{'){
                    bracketDepth++
                }
                else if((char === ']' || char === '}') && bracketDepth > 0){
                    bracketDepth--
                }
            }
            value += char
        }
        tokens.push({ value, start })
    }
    return tokens
}
