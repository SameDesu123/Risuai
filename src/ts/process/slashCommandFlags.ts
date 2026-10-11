// Pure helpers for regex script flags and slash command metadata.
// Kept free of database/store imports so they can be unit tested.

const flagTagRegex = /(<.+?>)/g
const commandNameRegex = /^[\p{L}\p{N}_-]+$/u

export function isValidCommandName(name:string){
    return commandNameRegex.test(name)
}

// Accepts hello, /hello, ^/hello or ^\/hello and returns hello.
// Also strips characters that would break the <...> flag syntax.
export function normalizeCommandName(name:string){
    return name.replace(/[<>,]/g, '').trim().replace(/^\^/, '').replace(/^(\\?\/)+/, '')
}

// Toggles a flag while leaving custom <...> tags untouched.
// Single letter flags only look outside of tags, so toggling 'm' never touches '<move_top>'.
export function toggleRegexFlag(flag:string, target:string){
    flag = flag ?? ''
    if(target.length !== 1){
        return flag.includes(target) ? flag.replace(target, '') : flag + target
    }
    const parts = flag.split(flagTagRegex)
    const contains = parts.some((part, i) => i % 2 === 0 && part.includes(target))
    if(!contains){
        return flag + target
    }
    return parts.map((part, i) => i % 2 === 0 ? part.replaceAll(target, '') : part).join('')
}

export function hasRegexFlag(flag:string, target:string){
    flag = flag ?? ''
    if(target.length === 1){
        return flag.replace(/<(.+?)>/g, '').includes(target)
    }
    return flag.includes(target)
}

function isCommandMeta(meta:string){
    return meta === 'command' || meta.startsWith('command ')
}

// Every meta inside <...> tags, split on commas the same way processScript does
export function getFlagMetas(flag:string|undefined|null){
    const metas:string[] = []
    for(const match of (flag ?? '').matchAll(/<(.+?)>/g)){
        metas.push(...match[1].split(',').map((v) => v.trim()))
    }
    return metas
}

export function getCommandFlag(flag:string|undefined|null):string|null{
    for(const meta of getFlagMetas(flag)){
        if(meta.startsWith('command ')){
            const name = meta.substring(8).trim()
            if(name){
                return name
            }
        }
    }
    return null
}

export function setCommandFlag(flag:string|undefined|null, name:string){
    let result = (flag ?? '').replace(/<(.+?)>/g, (tag:string, inner:string) => {
        const metas = inner.split(',').map((v) => v.trim())
        if(!metas.some(isCommandMeta)){
            return tag
        }
        const rest = metas.filter((m) => !isCommandMeta(m))
        return rest.length > 0 ? `<${rest.join(', ')}>` : ''
    })
    name = normalizeCommandName(name)
    if(name){
        result += `<command ${name}>`
    }
    return result
}

// Named capture groups in IN become the argument hint, e.g. (?<count>\d+) -> <count>
export function getRegexArgNames(regexIn:string){
    const names:string[] = []
    for(const match of regexIn.matchAll(/\(\?<([^>=!]+)>/g)){
        names.push(match[1])
    }
    return names
}

// JS regex flags of a script, the same way processScript derives them, minus 'g' so test() is stateless
export function getScriptRegexFlags(flag:string|undefined|null, ableFlag:boolean|undefined){
    let f = ableFlag ? (flag || 'g') : 'g'
    f = f.replace(/<(.+?)>/g, '').trim().replace(/[^dimsuvy]/g, '')
    f = f.split('').filter((v, i, a) => a.indexOf(v) === i).join('')
    return f.length === 0 ? 'u' : f
}

export function getCommandNameFromInput(input:string):string|null{
    if(!input.startsWith('/')){
        return null
    }
    const name = input.substring(1).split(/\s/, 1)[0]
    return name ? name : null
}

// Whether IN can only match text starting with "/name"
export function isAnchoredToCommand(regexIn:string, name:string){
    const names = [name, name.replaceAll('-', '\\-')]
    return names.some((n) => regexIn.startsWith(`^/${n}`) || regexIn.startsWith(`^\\/${n}`))
}
