import { describe, expect, it } from "vitest"
import {
    computeContentHash,
    exportSigningKeyFile,
    generateSigningKey,
    parseSigningKeyFile,
    signChain,
    stableStringify,
    verifyChain,
    type SignableCharacter,
} from "./creatorSignature"

function makeChar(overrides:SignableCharacter = {}):SignableCharacter{
    return {
        name: 'Alice',
        desc: 'A curious girl',
        firstMessage: 'Hello!',
        alternateGreetings: ['Hi'],
        globalLore: [{
            key: 'rabbit,hole',
            secondkey: '',
            insertorder: 100,
            comment: 'Rabbit',
            content: 'A white rabbit',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
        }],
        customscript: [{ comment: 'r', in: 'a', out: 'b', type: 'editoutput' }],
        triggerscript: [{ comment: 't', type: 'start', conditions: [], effect: [] }],
        ...overrides,
    }
}

// Mimics a card going through JSON export and import
function roundTrip<T>(value:T):T{
    return JSON.parse(JSON.stringify(value))
}

describe("creator signature", () => {
    it("serializes objects independent of key order", () => {
        expect(stableStringify({ b: 1, a: [1, { d: undefined, c: 2 }] })).toBe('{"a":[1,{"c":2}],"b":1}')
    })

    it("hashes lorebook keys independent of comma spacing and runtime trigger flags", async () => {
        const base = await computeContentHash(makeChar())
        const respaced = makeChar()
        respaced.globalLore[0].key = 'rabbit, hole'
        respaced.triggerscript[0].lowLevelAccess = false
        expect(await computeContentHash(respaced)).toBe(base)
    })

    it("hashes creator notes the same before and after the multi-language editor rewrites them", async () => {
        const base = await computeContentHash(makeChar({ creatorNotes: 'Made by Alice' }))
        expect(await computeContentHash(makeChar({ creatorNotes: '\n# `en`\nMade by Alice' }))).toBe(base)
        expect(await computeContentHash(makeChar({ creatorNotes: '\n# `en`\nMade by Alice\n# `ko`\nAlice 제작' }))).not.toBe(base)
        expect(await computeContentHash(makeChar({ creatorNotes: '' }))).toBe(await computeContentHash(makeChar({ creatorNotes: '\n# `en`\n ' })))
    })

    it("verifies an untouched card and detects modification", async () => {
        const key = await generateSigningKey('Author')
        const char = makeChar()
        const chain = roundTrip(await signChain([], char, key))
        expect(chain).toHaveLength(1)
        expect((await verifyChain(chain, roundTrip(char))).status).toBe('verified')
        expect((await verifyChain(chain, makeChar({ desc: 'Changed' }))).status).toBe('modified')
    })

    it("rejects tampered names, author ids and reordered chains", async () => {
        const author = await generateSigningKey('Author')
        const editor = await generateSigningKey('Editor')
        const char = makeChar()
        const chain = await signChain([], char, author)

        const renamed = roundTrip(chain)
        renamed[0].name = 'Someone else'
        expect((await verifyChain(renamed, char)).status).toBe('invalid')

        const reId = roundTrip(chain)
        reId[0].authorId = editor.authorId
        expect((await verifyChain(reId, char)).status).toBe('invalid')

        const edited = makeChar({ desc: 'Edited' })
        const twoChain = await signChain(chain, edited, editor)
        expect((await verifyChain(twoChain, edited)).status).toBe('verified')
        expect((await verifyChain([twoChain[1], twoChain[0]], edited)).status).toBe('invalid')
    })

    it("keeps, replaces or appends entries depending on who signs", async () => {
        const author = await generateSigningKey('Author')
        const editor = await generateSigningKey('Editor')
        const char = makeChar()
        const chain = await signChain([], char, author)

        expect(await signChain(chain, char, editor)).toEqual(chain)

        const authorEdit = await signChain(chain, makeChar({ desc: 'v2' }), author)
        expect(authorEdit).toHaveLength(1)
        expect(authorEdit[0].sig).not.toBe(chain[0].sig)

        const editorEdit = await signChain(chain, makeChar({ desc: 'v2' }), editor)
        expect(editorEdit.map((e) => e.name)).toEqual(['Author', 'Editor'])
        expect(editorEdit[1].prev).toBe(chain[0].sig)

        const editorAgain = await signChain(editorEdit, makeChar({ desc: 'v3' }), editor)
        expect(editorAgain.map((e) => e.name)).toEqual(['Author', 'Editor'])
        expect((await verifyChain(editorAgain, makeChar({ desc: 'v3' }))).status).toBe('verified')
    })

    it("restarts the chain when the existing one is invalid", async () => {
        const author = await generateSigningKey('Author')
        const editor = await generateSigningKey('Editor')
        const chain = roundTrip(await signChain([], makeChar(), author))
        chain[0].name = 'Forged'
        const resigned = await signChain(chain, makeChar({ desc: 'v2' }), editor)
        expect(resigned.map((e) => e.name)).toEqual(['Editor'])
    })

    it("round trips the signing key file", async () => {
        const key = await generateSigningKey('Author')
        const parsed = await parseSigningKeyFile(exportSigningKeyFile(key))
        expect(parsed.authorId).toBe(key.authorId)
        const chain = await signChain([], makeChar(), parsed)
        expect((await verifyChain(chain, makeChar())).status).toBe('verified')
    })

    it("rejects key files whose private key does not match the public key", async () => {
        const a = await generateSigningKey('A')
        const b = await generateSigningKey('B')
        const mixed = exportSigningKeyFile({ ...a, privateKey: b.privateKey })
        await expect(parseSigningKeyFile(mixed)).rejects.toThrow()
        await expect(parseSigningKeyFile('{"type":"other"}')).rejects.toThrow()
    })
})
