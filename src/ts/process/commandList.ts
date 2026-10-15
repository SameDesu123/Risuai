import { language } from "../../lang";

export interface ChatCommandInfo {
    name: string
    usage: string
    description: () => string
}

// Built-in slash commands handled by processCommand in ./command.ts
export const builtinCommands: ChatCommandInfo[] = [
    { name: 'input', usage: '[text]', description: () => language.chatCommands.input },
    { name: 'echo', usage: '[text]', description: () => language.chatCommands.echo },
    { name: 'popup', usage: '[text]', description: () => language.chatCommands.popup },
    { name: 'pass', usage: '[text]', description: () => language.chatCommands.pass },
    { name: 'buttons', usage: 'labels=[JSON array]', description: () => language.chatCommands.buttons },
    { name: 'speak', usage: '[text]', description: () => language.chatCommands.speak },
    { name: 'send', usage: '[text]', description: () => language.chatCommands.send },
    { name: 'sendas', usage: '[text]', description: () => language.chatCommands.sendas },
    { name: 'comment', usage: '[text]', description: () => language.chatCommands.comment },
    { name: 'cut', usage: '[index | start-end | chatId]', description: () => language.chatCommands.cut },
    { name: 'del', usage: '[count]', description: () => language.chatCommands.del },
    { name: 'len', usage: '[JSON array]', description: () => language.chatCommands.len },
    { name: 'multisend', usage: '[text]|||[text]...', description: () => language.chatCommands.multisend },
    { name: 'setvar', usage: 'key=[key] [value]', description: () => language.chatCommands.setvar },
    { name: 'addvar', usage: 'key=[key] [value]', description: () => language.chatCommands.addvar },
    { name: 'getvar', usage: 'key=[key]', description: () => language.chatCommands.getvar },
    { name: 'trigger', usage: '[name]', description: () => language.chatCommands.trigger },
    { name: '?', usage: '', description: () => language.chatCommands.help },
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

// Returns the sections with commands matching the command name being typed, or null when the list should not be shown
export function getCommandSuggestions(input: string): CommandSection[] | null {
    if(!input.startsWith('/') || /\s/.test(input)){
        return null
    }
    const query = input.slice(1).toLowerCase()
    return getCommandSections()
        .map((section) => ({ ...section, commands: section.commands.filter((c) => c.name.startsWith(query)) }))
        .filter((section) => section.commands.length > 0)
}
