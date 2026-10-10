import { describe, expect, it } from "vitest"
import {
    attributionForExport,
    attributionFromImport,
    canonicalJSON,
    computeContentHash,
    computeIntegrity,
    getLocalAttributionIdentity,
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

    describe("lorebook settings", () => {
        const lore = {
            key: "castle, gate",
            secondkey: "night",
            content: "The castle is old.",
            comment: "Castle",
            insertorder: 100,
            alwaysActive: false,
            selective: true,
        }
        const base = { ...makeChar(), globalLore: [lore] }

        it.each([
            ["activation keys", { key: "castle, gate, tower" }],
            ["secondary keys", { secondkey: "day" }],
            ["always active", { alwaysActive: true }],
            ["insertion order", { insertorder: 50 }],
            ["selective", { selective: false }],
            ["name", { comment: "Fortress" }],
            ["case sensitivity", { extentions: { risu_case_sensitive: true } }],
        ])("detects a change to %s", (_label, patch) => {
            expect(computeContentHash({ ...base, globalLore: [{ ...lore, ...patch }] })).not.toBe(computeContentHash(base))
        })

        it("ignores key spacing that the export/import round trip normalizes", () => {
            const joined = { ...lore, key: "castle,gate", secondkey: " night " }
            expect(computeContentHash({ ...base, globalLore: [joined] })).toBe(computeContentHash(base))
        })

        it("ignores secondary keys on non-selective entries (they are not exported)", () => {
            const a = { ...lore, selective: false, secondkey: "x" }
            const b = { ...lore, selective: false, secondkey: "y" }
            expect(computeContentHash({ ...base, globalLore: [a] })).toBe(computeContentHash({ ...base, globalLore: [b] }))
        })

        it("detects lore setting changes but ignores incomplete settings that import drops", () => {
            const withSettings = { ...base, loreSettings: { scanDepth: 5, tokenBudget: 800, recursiveScanning: false } }
            expect(computeContentHash({ ...withSettings, loreSettings: { ...withSettings.loreSettings, scanDepth: 10 } }))
                .not.toBe(computeContentHash(withSettings))
            expect(computeContentHash({ ...base, loreSettings: { scanDepth: 5 } })).toBe(computeContentHash(base))
        })

        it("records a fork when only lorebook settings were edited", () => {
            const atBob = transfer(base, attributionForExport(base, alice))
            const edited = { ...atBob, globalLore: [{ ...lore, alwaysActive: true }] }
            expect(attributionForExport(edited, bob).forks).toEqual([bob])
        })
    })

    describe("migration baseline", () => {
        const imported = { ...makeChar(), globalLore: [{ key: "a", content: "<char> waves." }] }
        const migrated = { ...imported, globalLore: [{ key: "a", content: "{{char}} waves." }] }

        it("verifies against the imported form but uses the migrated form as the edit baseline", () => {
            const exported = JSON.parse(JSON.stringify(attributionForExport(imported, alice)))
            const attr = attributionFromImport(exported, imported, migrated)
            expect(attr.unverified).toBe(false)
            const reExport = attributionForExport({ ...migrated, imported: true, attribution: attr }, bob)
            expect(reExport.forks).toEqual([])
            expect(reExport.original).toEqual(alice)
        })

        it("still records a fork for real edits after migration", () => {
            const exported = JSON.parse(JSON.stringify(attributionForExport(imported, alice)))
            const attr = attributionFromImport(exported, imported, migrated)
            const edited = { ...migrated, desc: "changed", imported: true, attribution: attr }
            expect(attributionForExport(edited, bob).forks).toEqual([bob])
        })
    })

    describe("local identity", () => {
        it("creates a secret in the background and never carries a name", () => {
            const db: { cardAttributionSecret?: string } = {}
            const me = getLocalAttributionIdentity(db)
            expect(db.cardAttributionSecret).toMatch(/^[0-9a-f]{64}$/)
            expect(me).toEqual({ name: "", id: identityIdFromSecret(db.cardAttributionSecret!) })
            expect(getLocalAttributionIdentity(db)).toEqual(me)
        })

        it("writes an empty name for a card made here", () => {
            const me = getLocalAttributionIdentity({ cardAttributionSecret: "d".repeat(64) })
            expect(attributionForExport(makeChar(), me).original).toEqual({ name: "", id: me.id })
        })
    })
})
