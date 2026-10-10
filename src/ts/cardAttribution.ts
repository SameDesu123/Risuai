import { Sha256 } from "@aws-crypto/sha256-js"

/**
 * Card attribution: records who originally made a character card and who
 * forked it afterwards, so the original creator stays visible when a card is
 * re-shared through Risuai's normal import/export flow.
 *
 * This is not a security boundary. Anyone who edits the card JSON by hand and
 * recomputes the hashes can rewrite the history. The goal is that the default
 * flow never drops the original creator, and that hand edits are noticed.
 */

export const ATTRIBUTION_VERSION = 1
export const MAX_FORK_ENTRIES = 16
const MAX_NAME_LENGTH = 64
const ID_PREFIX = 'risu-card-attribution:'
const HEX64 = /^[0-9a-f]{64}$/

export interface AttributionEntry {
    /** Display name chosen by the creator. Free text, never trusted as identity. */
    name: string
    /** SHA-256 of the creator's local secret. This is the actual identity. */
    id: string
}

export interface CardAttribution {
    version: number
    /** null means the original creator is unknown (card had no record when imported). */
    original: AttributionEntry | null
    /** People who modified the card after the original, oldest first. */
    forks: AttributionEntry[]
    /** Hash of the creator-authored fields at the time this record was written. */
    contentHash: string
    /** Set once a mismatch was seen on import. Covered by integrity, so it cannot be silently dropped. */
    unverified: boolean
    /** Hash over everything above. */
    integrity: string
    /** Reserved for a future digital signature. Always null for now. */
    signature: null
}

export interface AttributionIdentity {
    name: string
    id: string
}

/** The subset of a character that is hashed. Kept to fields that survive an export/import round trip. */
export interface AttributionContentSource {
    name?: string
    desc?: string
    personality?: string
    scenario?: string
    firstMessage?: string
    exampleMessage?: string
    systemPrompt?: string
    replaceGlobalNote?: string
    creatorNotes?: string
    alternateGreetings?: string[]
    backgroundHTML?: string
    globalLore?: AttributionLoreSource[]
    loreSettings?: {
        scanDepth?: number
        tokenBudget?: number
        recursiveScanning?: boolean
        fullWordMatching?: boolean
    }
}

/** Lorebook fields that survive v2, v3 and charx export/import unchanged. */
export interface AttributionLoreSource {
    key?: string
    secondkey?: string
    content?: string
    comment?: string
    mode?: string
    insertorder?: number
    alwaysActive?: boolean
    selective?: boolean
    activationPercent?: number | null
    extentions?: { risu_case_sensitive?: boolean } & Record<string, unknown>
}

// Export splits keys on ',' and trims; import joins with ', '. Hash the split form so both sides agree.
function splitKeys(keys: string | undefined): string[] {
    return (keys ?? '').split(',').map((k) => k.trim())
}

function loreHashPayload(l: AttributionLoreSource) {
    return {
        key: splitKeys(l?.key),
        // Secondary keys are only exported for selective entries.
        secondkey: l?.selective ? splitKeys(l?.secondkey) : [],
        content: l?.content ?? '',
        comment: l?.comment ?? '',
        mode: l?.mode ?? 'normal',
        insertorder: l?.insertorder ?? null,
        alwaysActive: !!l?.alwaysActive,
        selective: !!l?.selective,
        caseSensitive: !!l?.extentions?.risu_case_sensitive,
        activationPercent: l?.activationPercent ?? null,
    }
}

function loreSettingsHashPayload(s: AttributionContentSource['loreSettings']) {
    // Import only restores lore settings when all three core values are present.
    if (!s || s.scanDepth == null || s.tokenBudget == null || s.recursiveScanning == null) {
        return null
    }
    return {
        scanDepth: s.scanDepth,
        tokenBudget: s.tokenBudget,
        recursiveScanning: s.recursiveScanning,
        fullWordMatching: !!s.fullWordMatching,
    }
}

function toHex(bytes: Uint8Array): string {
    let out = ''
    for (const b of bytes) {
        out += b.toString(16).padStart(2, '0')
    }
    return out
}

export function sha256Hex(text: string): string {
    const hash = new Sha256()
    hash.update(new TextEncoder().encode(text))
    return toHex(hash.digestSync())
}

/** JSON with sorted object keys, so the same data always hashes the same way. */
export function canonicalJSON(value: unknown): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value ?? null)
    }
    if (Array.isArray(value)) {
        return '[' + value.map((v) => canonicalJSON(v)).join(',') + ']'
    }
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}'
}

export function generateAttributionSecret(): string {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return toHex(bytes)
}

export function isValidAttributionSecret(secret: unknown): secret is string {
    return typeof secret === 'string' && HEX64.test(secret)
}

export function identityIdFromSecret(secret: string): string {
    return sha256Hex(ID_PREFIX + secret)
}

export function normalizeCreatorName(name: unknown): string {
    if (typeof name !== 'string') {
        return ''
    }
    return name.trim().slice(0, MAX_NAME_LENGTH)
}

export function computeContentHash(char: AttributionContentSource): string {
    return sha256Hex(canonicalJSON({
        name: char.name ?? '',
        desc: char.desc ?? '',
        personality: char.personality ?? '',
        scenario: char.scenario ?? '',
        firstMessage: char.firstMessage ?? '',
        exampleMessage: char.exampleMessage ?? '',
        systemPrompt: char.systemPrompt ?? '',
        replaceGlobalNote: char.replaceGlobalNote ?? '',
        creatorNotes: char.creatorNotes ?? '',
        alternateGreetings: char.alternateGreetings ?? [],
        backgroundHTML: char.backgroundHTML ?? '',
        lore: (char.globalLore ?? []).map(loreHashPayload),
        loreSettings: loreSettingsHashPayload(char.loreSettings),
    }))
}

export function computeIntegrity(attr: Omit<CardAttribution, 'integrity' | 'signature'>): string {
    return sha256Hex(canonicalJSON({
        version: attr.version,
        original: attr.original,
        forks: attr.forks,
        contentHash: attr.contentHash,
        unverified: attr.unverified,
    }))
}

function parseEntry(raw: unknown): AttributionEntry | null {
    if (!raw || typeof raw !== 'object') {
        return null
    }
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string' || !HEX64.test(r.id) || typeof r.name !== 'string') {
        return null
    }
    return { name: r.name, id: r.id }
}

/**
 * Strictly parses a stored record. Returns null when the shape is wrong, so the
 * caller can tell "no record" from "broken record".
 */
export function parseAttribution(raw: unknown): CardAttribution | null {
    if (!raw || typeof raw !== 'object') {
        return null
    }
    const r = raw as Record<string, unknown>
    if (typeof r.version !== 'number' || typeof r.contentHash !== 'string' || typeof r.integrity !== 'string') {
        return null
    }
    let original: AttributionEntry | null = null
    if (r.original !== null) {
        original = parseEntry(r.original)
        if (!original) {
            return null
        }
    }
    if (!Array.isArray(r.forks)) {
        return null
    }
    const forks: AttributionEntry[] = []
    for (const f of r.forks) {
        const entry = parseEntry(f)
        if (!entry) {
            return null
        }
        forks.push(entry)
    }
    return {
        version: r.version,
        original,
        forks,
        contentHash: r.contentHash,
        unverified: r.unverified === true,
        integrity: r.integrity,
        signature: null,
    }
}

function seal(attr: Omit<CardAttribution, 'integrity' | 'signature'>): CardAttribution {
    return {
        version: attr.version,
        original: attr.original,
        forks: attr.forks,
        contentHash: attr.contentHash,
        unverified: attr.unverified,
        integrity: computeIntegrity(attr),
        signature: null,
    }
}

/**
 * Builds the record to keep on a freshly imported character.
 * `raw` is whatever the card carried (or undefined), `char` is the character exactly as imported.
 * `baseline` is the same character after the automatic migrations Risuai applies later
 * (e.g. lorebook format updates). The record is verified against `char`, but `baseline`
 * becomes the reference for detecting user edits, so a migration alone never counts as a fork.
 */
export function attributionFromImport(raw: unknown, char: AttributionContentSource, baseline: AttributionContentSource = char): CardAttribution {
    const importedHash = computeContentHash(char)
    const contentHash = baseline === char ? importedHash : computeContentHash(baseline)
    if (raw === undefined || raw === null) {
        return seal({ version: ATTRIBUTION_VERSION, original: null, forks: [], contentHash, unverified: false })
    }
    const parsed = parseAttribution(raw)
    if (!parsed) {
        // A record was present but malformed: original creator is unknown and we remember that it looked tampered.
        return seal({ version: ATTRIBUTION_VERSION, original: null, forks: [], contentHash, unverified: true })
    }
    const matches = parsed.contentHash === importedHash && computeIntegrity(parsed) === parsed.integrity
    return seal({
        version: ATTRIBUTION_VERSION,
        original: parsed.original,
        forks: parsed.forks,
        contentHash,
        unverified: parsed.unverified || !matches,
    })
}

/**
 * Builds the record to write into an exported card.
 *
 * - No record and not imported: the character was made here, so the exporter is the original creator.
 * - No record but imported (legacy import): original creator is unknown; nobody is credited.
 * - Content changed since the record and the exporter is not the last person in the history: exporter is appended as a fork.
 * - The exporter's own entries get their current display name.
 */
export function attributionForExport(
    char: AttributionContentSource & { attribution?: CardAttribution | null, imported?: boolean },
    identity: AttributionIdentity
): CardAttribution {
    const contentHash = computeContentHash(char)
    const me: AttributionEntry = { name: normalizeCreatorName(identity.name), id: identity.id }
    const stored = char.attribution ? parseAttribution(char.attribution) : null

    let original: AttributionEntry | null
    let forks: AttributionEntry[]
    let baseHash: string
    let unverified: boolean

    if (stored) {
        original = stored.original ? { ...stored.original } : null
        forks = stored.forks.map((f) => ({ ...f }))
        baseHash = stored.contentHash
        unverified = stored.unverified
    } else if (char.attribution) {
        // Stored record exists but is broken.
        original = null
        forks = []
        baseHash = contentHash
        unverified = true
    } else {
        original = char.imported ? null : { ...me }
        forks = []
        baseHash = contentHash
        unverified = false
    }

    const last = forks.length > 0 ? forks[forks.length - 1] : original
    if (contentHash !== baseHash && last?.id !== me.id) {
        forks.push({ ...me })
    }

    if (me.name) {
        if (original?.id === me.id) {
            original.name = me.name
        }
        for (const f of forks) {
            if (f.id === me.id) {
                f.name = me.name
            }
        }
    }

    if (forks.length > MAX_FORK_ENTRIES) {
        forks = forks.slice(forks.length - MAX_FORK_ENTRIES)
    }

    return seal({ version: ATTRIBUTION_VERSION, original, forks, contentHash, unverified })
}

/** Short, human-comparable form of an identity id. */
export function attributionFingerprint(id: string): string {
    return id.slice(0, 4) + '-' + id.slice(4, 8)
}

/**
 * Reads (and if needed creates) the local identity from a database-like object.
 * Mutates `db` only to create a missing secret.
 */
export function getLocalAttributionIdentity(db: { cardAttributionSecret?: string, cardAttributionName?: string }): AttributionIdentity {
    if (!isValidAttributionSecret(db.cardAttributionSecret)) {
        db.cardAttributionSecret = generateAttributionSecret()
    }
    return {
        name: normalizeCreatorName(db.cardAttributionName),
        id: identityIdFromSecret(db.cardAttributionSecret),
    }
}

/** Like getLocalAttributionIdentity but never mutates; returns null when no secret exists yet. Safe inside derived state. */
export function peekLocalAttributionIdentity(db: { cardAttributionSecret?: string, cardAttributionName?: string }): AttributionIdentity | null {
    if (!isValidAttributionSecret(db.cardAttributionSecret)) {
        return null
    }
    return {
        name: normalizeCreatorName(db.cardAttributionName),
        id: identityIdFromSecret(db.cardAttributionSecret),
    }
}
