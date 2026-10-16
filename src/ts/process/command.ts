import { get } from "svelte/store";
import { getCurrentCharacter, getCurrentChat, getDatabase, setCurrentChat, setDatabase } from "../storage/database.svelte";
import { selectedCharID } from "../stores.svelte";
import { alertInput, alertMd, alertNormal, alertSelect } from "../alert";
import { sayTTS } from "./tts";
import { risuChatParser } from "../parser/parser.svelte";
import { sendChat } from "./index.svelte";
import { loadLoreBookV3Prompt } from "./lorebook.svelte";
import { runTrigger } from "./triggers";

export async function processMultiCommand(command:string) {
    let pipe = ''
    const splited:string[] = []
    let lastIndex = 0
    let quoteDepth = false
    for(let i = 0; i<command.length; i++){
        const char = command[i]
        if(char === '"'){
            quoteDepth = !quoteDepth
        }
        else if(char === '|' && quoteDepth === false){
            splited.push(command.slice(lastIndex, i))
            lastIndex = i+1
        }
    }
    splited.push(command.slice(lastIndex))
    console.log(splited)
    for(let i = 0; i<splited.length; i++){
        const result = await processCommand(splited[i].trim(), pipe)
        console.log(pipe)
        if(result === false){
            return false
        }
        else{
            pipe = result
        }
    }
    return pipe
}


async function processCommand(command:string, pipe:string):Promise<false | string>{
    const db = getDatabase()
    const currentChar = db.characters[get(selectedCharID)]
    const currentChat = currentChar.chats[currentChar.chatPage]
    const {commandName, args, rest, named} = commandParser(command, pipe, (text) => risuChatParser(text, {
        chara: currentChar.type === 'character' ? currentChar : null
    }))
    // free text commands take the whole line as one argument
    const arg = rest(0) ?? ''
    // `/setvar key value`, or the STScript style `/setvar key=key value`. The value falls back to the pipe.
    const varArgs = () => ({
        key: named('key') ?? args[0] ?? '',
        value: rest(1) ?? pipe,
    })

    switch(commandName){
        //STScript compatibility commands
        case 'input':{
            pipe = await alertInput(arg)
            return pipe
        }
        case 'echo':
        case 'popup':{
            alertNormal(arg)
            return pipe
        }
        case 'pass':{
            pipe = arg
            return pipe
        }
        case 'buttons': {
            // `/buttons Yes No "Not sure"`, or the STScript style `/buttons labels=["Yes","No"]`
            let labels = args
            const labelsJSON = named('labels')
            if(labelsJSON !== undefined){
                try {
                    const parsed = JSON.parse(labelsJSON)
                    labels = Array.isArray(parsed) ? parsed.map((e) => String(e)) : []
                } catch (error) {
                    labels = []
                }
            }
            labels = labels.filter((e) => e !== '')
            if(labels.length > 0){
                // alertSelect gives back the index of the chosen button
                pipe = labels[Number(await alertSelect(labels))] ?? ''
            }
            return pipe
        }
        case 'setinput': {
            //NOT IMPLEMENTED
            return false
        }
        case 'speak': {
            if(currentChar.type === 'character'){
                await sayTTS(currentChar, arg)
                return pipe
            }
            if(currentChar.type === 'group'){
                //NOT IMPLEMENTED
                return pipe
            }
            return pipe
        }
        case 'send': {
            currentChat.message.push({
                role: "user",
                data: arg
            })
            setDatabase(db)
            return pipe
        }
        case 'sendas': {
            //name not implemented
            currentChat.message.push({
                role: "char",
                data: arg
            })
            setDatabase(db)
            return pipe
        }
        case 'comment': {
            //works differently, but its close enough
            const addition = `<Comment>\n${arg}\n</Comment>`
            currentChat.message[currentChat.message.length-1].data += addition
            setDatabase(db)
            return pipe
        }
        case 'cut':{
            const target = args[0] ?? ''
            if(target.includes('-')){
                const [start, end] = target.split('-')
                currentChat.message = currentChat.message.slice(parseInt(start), parseInt(end))
                setDatabase(db)
            }
            else if(!isNaN(parseInt(target))){
                const index = parseInt(target)
                currentChat.message = currentChat.message.splice(index, 1)
                setDatabase(db)
            }
            else{ //For risu, doesn'ts work for STScript
                const id = target
                currentChat.message = currentChat.message.filter((e)=>e.chatId !== id)
                setDatabase(db)
            }
            return pipe
        }
        case 'del': {
            const size = parseInt(args[0])
            if(!isNaN(size)){
                currentChat.message = currentChat.message.slice(currentChat.message.length-size)
                setDatabase(db)
            }
            return pipe
        }
        case 'len':{
            try {
                const parsed = JSON.parse(arg)
                if(Array.isArray(parsed)){
                    pipe = parsed.length.toString()
                }
            } catch (error) {}
            return pipe
        }
        case 'multisend':{
            const splited = arg.split('|||')
            let clearMode = false
            if(splited[0] && splited[0].trim() === 'clear'){
                clearMode = true
                splited.shift()
            }
            for(const e of splited){
                if(clearMode){
                    currentChat.message = []
                }
                currentChat.message.push({
                    role: 'user',
                    data: e
                })
                await sendChat(-1)
            }
            return ''
        }
        case 'setvar':{
            const { key, value } = varArgs()
            const db = getDatabase()
            const selectedChar = get(selectedCharID)
            const char = db.characters[selectedChar]
            const chat = char.chats[char.chatPage]
            chat.scriptstate = chat.scriptstate ?? {}
            chat.scriptstate['$' + key] = value
            console.log(chat.scriptstate)

            char.chats[char.chatPage] = chat
            db.characters[selectedChar] = char
            setDatabase(db)
            return ''
        }
        case 'addvar':{
            const { key, value } = varArgs()
            const db = getDatabase()
            const selectedChar = get(selectedCharID)
            const char = db.characters[selectedChar]
            const chat = char.chats[char.chatPage]
            chat.scriptstate = chat.scriptstate ?? {}
            chat.scriptstate['$' + key] = (Number(chat.scriptstate['$' + key]) + Number(value)).toString()

            char.chats[char.chatPage] = chat
            db.characters[selectedChar] = char
            setDatabase(db)
            return ''
        }
        case 'getvar':{
            const { key } = varArgs()
            const db = getDatabase()
            const selectedChar = get(selectedCharID)
            const char = db.characters[selectedChar]
            const chat = char.chats[char.chatPage]
            chat.scriptstate = chat.scriptstate ?? {}
            pipe = (chat.scriptstate['$' + key]).toString() ?? 'null'
            return pipe
        }
        case 'test_lorebook':{
            const p = await loadLoreBookV3Prompt()
            console.log(p)
            alertNormal(p.actives.map((e)=>e.prompt).join('§'))
            return JSON.stringify(p)
        }
        case 'trigger':{
            const currentChar = getCurrentCharacter()
            if(currentChar.type === 'group'){
                return;
            }
            const triggerResult = await runTrigger(currentChar, 'manual', {
                chat: getCurrentChat(),
                manualName: arg
            });

            if(triggerResult){
               setCurrentChat(triggerResult.chat);
            }
            return
        }
        case '?':{
            alertMd(`
            Arguments are separated by spaces. Wrap an argument in double quotes to keep its spaces,
            and the last argument of a text command takes the rest of the line.
            # /input [text]
            - Show input dialog
            - Return input text
            - Example: /input Hello World
            # /echo [text]
            - Show alert dialog
            - Return input text
            - Example: /echo Hello World
            # /popup [text]
            - Show alert dialog
            - Return input text
            - Example: /popup Hello World
            # /pass [text]
            - Return input text
            - Example: /pass Hello World
            # /buttons [label] [label] ...
            - Show select dialog
            - Return selected label
            - Example: /buttons Yes No "Not sure"
            # /speak [text]
            - Speak text
            - Example: /speak Hello World
            # /send [text]
            - Send text to chat
            - Example: /send Hello World
            # /sendas [text]
            - Send text to chat as character
            - Example: /sendas Hello World
            # /comment [text]
            - Add comment to chat
            - Example: /comment Hello World
            # /cut [index]
            - Cut chat message
            - Example: /cut 1
            # /del [size]
            - Delete chat message
            - Example: /del 1
            # /len [array]
            - Return length of JSON array
            - Example: /len ["Hello", "World"]
            # /setvar [key] [value]
            - Set variable
            - Example: /setvar greeting hello world
            # /addvar [key] [value]
            - Add value to variable
            - Example: /addvar damage 10
            # /getvar [key]
            - Get variable
            - Example: /getvar damage
            # /trigger [name]
            - Run trigger
            - Example: /trigger my trigger
            # /?
            - Show help
            `)
            return 'help'
        }


    }
    return false
}


interface CommandToken {
    // argument text, without the quotes that grouped it
    value: string
    // offset of the argument in the argument line
    start: number
}

// Splits the argument line on whitespace.
// Double quotes group words into one argument, and nothing inside brackets is split,
// so JSON like ["a", "b"] and CBS like {{getvar::a b}} each stay one argument.
function tokenizeArgs(line:string):CommandToken[]{
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

// Parses `/command <arg1> <arg2> <arg3>...`
function commandParser(command:string, pipe:string, parse:(text:string) => string){
    command = command.trim()
    if(command.startsWith('/')){
        command = command.slice(1)
    }
    const nameEnd = command.search(/\s/)
    const commandName = nameEnd === -1 ? command : command.slice(0, nameEnd)
    let line = nameEnd === -1 ? '' : command.slice(nameEnd).trim()
    let tokens = tokenizeArgs(line)
    if(tokens.length === 0){
        // with no arguments, the piped value becomes the first argument
        line = pipe
        tokens = [{ value: pipe, start: 0 }]
    }

    const fill = (text:string) => parse(text
        .replaceAll('{{pipe}}', pipe) //STScript compatibility
        .replaceAll('{{slot}}', pipe) //Risu default
    )
    const args = tokens.map((token) => fill(token.value))

    return {
        commandName,
        args,
        // The line from the index-th argument to the end, for a last argument that takes free text.
        // A single quoted argument loses its quotes, longer text is kept as typed.
        rest: (index:number):string|undefined => {
            if(index >= tokens.length){
                return undefined
            }
            if(index === tokens.length - 1){
                return args[index]
            }
            return fill(line.slice(tokens[index].start))
        },
        // STScript style named argument, given first as `name=value`
        named: (name:string):string|undefined => {
            const prefix = name + '='
            if(!line.startsWith(prefix)){
                return undefined
            }
            return fill(tokens[0].value.slice(prefix.length))
        },
    }
}
