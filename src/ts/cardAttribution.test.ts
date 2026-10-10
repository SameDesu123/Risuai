import { describe, expect, it } from "vitest"
import {
    attributionForExport,
    attributionFromImport,
    canonicalJSON,
    computeIntegrity,
    identityIdFromSecret,
    MAX_FORK_ENTRIES,
    type AttributionIdentity,
    type CardAttribution,
} from "./cardAttribution"

const alice: AttributionIdentity = { name: "Alice", id: identityIdFromSecret("a".repeat(64)) }
const bob: AttributionIdentity = { name: "Bob", id: identityIdFromSecret("b".repeat(64)) }
const carol: AttributionIdentity = { name: "Carol", id: identityIdFromSecret("c".repeat(64)) }

function makeChar(desc = "A brave knight.") {
    return {
        name: "Knight",
        desc,
        firstMessage: "Hello.",
        creatorNotes: "Made with love.",
        globalLore: [{ content: "The castle is old." }],
    }
}

/** Simulates writing a card and importing it on another machine. */
function transfer(char: ReturnType<typeof makeChar>, exported: CardAttribution) {
    const wire = JSON.parse(JSON.stringify(exported))
    return { ...char, imported: true, attribution: attributionFromImport(wire, char) }
}

describe("card attribution", () => {
    it("canonical JSON ignores key order", () => {
        expect(canonicalJSON({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonicalJSON({ a: [1, { c: 3, d: 2 }], b: 1 }))
    })

    it("credits the local creator as original for a card made here", () => {
        const out = attributionForExport(makeChar(), alice)
        expect(out.original).toEqual(alice)
        expect(out.forks).toEqual([])
        expect(out.unverified).toBe(false)
        expect(out.signature).toBeNull()
    })

    it("does not credit anyone for a legacy imported card without a record", () => {
        const out = attributionForExport({ ...makeChar(), imported: true }, bob)
        expect(out.original).toBeNull()
        expect(out.forks).toEqual([])
    })

    it("keeps the original creator through unchanged re-shares", () => {
        const char = makeChar()
        const a = attributionForExport(char, alice)
        const atBob = transfer(char, a)
        const b = attributionForExport(atBob, bob)
        const atCarol = transfer(char, b)
        const c = attributionForExport(atCarol, carol)
        expect(c.original).toEqual(alice)
        expect(c.forks).toEqual([])
        expect(atCarol.attribution.unverified).toBe(false)
    })

    it("appends a fork creator only when content changed", () => {
        const char = makeChar()
        const atBob = transfer(char, attributionForExport(char, alice))
        const edited = { ...atBob, desc: "A braver knight." }
        const b = attributionForExport(edited, bob)
        expect(b.original).toEqual(alice)
        expect(b.forks).toEqual([bob])
    })

    it("treats the original creator's own edits as updates, not forks", () => {
        const char = makeChar()
        const atAlice = transfer(char, attributionForExport(char, alice))
        const out = attributionForExport({ ...atAlice, desc: "Updated." }, alice)
        expect(out.original).toEqual(alice)
        expect(out.forks).toEqual([])
    })

    it("does not stack the same fork creator twice", () => {
        const char = makeChar()
        const atBob = transfer(char, attributionForExport(char, alice))
        const v1 = { ...atBob, desc: "v1" }
        const bobV1 = attributionForExport(v1, bob)
        const atBobAgain = transfer(v1, bobV1)
        const out = attributionForExport({ ...atBobAgain, desc: "v2" }, bob)
        expect(out.forks).toEqual([bob])
    })

    it("adds the original creator as a fork when they edit someone else's fork", () => {
        const char = makeChar()
        const atBob = transfer(char, attributionForExport(char, alice))
        const v1 = { ...atBob, desc: "bob edit" }
        const atAlice = transfer(v1, attributionForExport(v1, bob))
        const out = attributionForExport({ ...atAlice, desc: "alice edit" }, alice)
        expect(out.forks).toEqual([bob, alice])
    })

    it("updates the exporter's own name after a rename", () => {
        const char = makeChar()
        const atAlice = transfer(char, attributionForExport(char, alice))
        const out = attributionForExport(atAlice, { ...alice, name: "Alice2" })
        expect(out.original).toEqual({ name: "Alice2", id: alice.id })
    })

    it("flags a hand-edited creator name on import", () => {
        const char = makeChar()
        const exported = attributionForExport(char, alice)
        const tampered = JSON.parse(JSON.stringify(exported))
        tampered.original.name = "Mallory"
        const imported = attributionFromImport(tampered, char)
        expect(imported.unverified).toBe(true)
        expect(imported.original?.name).toBe("Mallory")
    })

    it("flags content edited outside Risuai", () => {
        const char = makeChar()
        const exported = attributionForExport(char, alice)
        const imported = attributionFromImport(exported, { ...char, desc: "edited elsewhere" })
        expect(imported.unverified).toBe(true)
    })

    it("keeps the mismatch flag through later re-exports (no laundering)", () => {
        const char = makeChar()
        const tampered = JSON.parse(JSON.stringify(attributionForExport(char, alice)))
        tampered.original.name = "Mallory"
        const atBob = { ...char, imported: true, attribution: attributionFromImport(tampered, char) }
        const b = attributionForExport(atBob, bob)
        expect(b.unverified).toBe(true)
        expect(b.integrity).toBe(computeIntegrity(b))
        const atCarol = transfer(char, b)
        expect(atCarol.attribution.unverified).toBe(true)
    })

    it("flags a stripped mismatch flag", () => {
        const char = makeChar()
        const tampered = JSON.parse(JSON.stringify(attributionForExport(char, alice)))
        tampered.original.name = "Mallory"
        const b = JSON.parse(JSON.stringify(attributionForExport(
            { ...char, imported: true, attribution: attributionFromImport(tampered, char) }, bob)))
        b.unverified = false
        expect(attributionFromImport(b, char).unverified).toBe(true)
    })

    it("treats a malformed record as unknown and unverified", () => {
        const imported = attributionFromImport({ version: 1, original: "Alice" }, makeChar())
        expect(imported.original).toBeNull()
        expect(imported.unverified).toBe(true)
    })

    it("treats a card without a record as unknown but verified", () => {
        const imported = attributionFromImport(undefined, makeChar())
        expect(imported.original).toBeNull()
        expect(imported.unverified).toBe(false)
    })

    it("caps the fork history", () => {
        let char: ReturnType<typeof makeChar> & { imported?: boolean, attribution?: CardAttribution } = makeChar()
        let exported = attributionForExport(char, alice)
        for (let i = 0; i < MAX_FORK_ENTRIES + 4; i++) {
            const who = { name: `F${i}`, id: identityIdFromSecret(i.toString(16).padStart(64, "0")) }
            const next = { ...transfer(char, exported), desc: `edit ${i}` }
            exported = attributionForExport(next, who)
            char = next
        }
        expect(exported.forks.length).toBe(MAX_FORK_ENTRIES)
        expect(exported.forks[exported.forks.length - 1].name).toBe(`F${MAX_FORK_ENTRIES + 3}`)
        expect(exported.original).toEqual(alice)
    })
})
