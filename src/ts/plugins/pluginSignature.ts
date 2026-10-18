/**
 * Plugin signature verification.
 *
 * A signed plugin carries two metadata lines (anywhere in the file, usually at the bottom):
 *
 *   //@signature-key <base64 raw P-256 public key (65 bytes, uncompressed)>
 *   //@signature <base64 ECDSA P-256 / SHA-256 signature (64 bytes, r||s)>
 *
 * The signed payload is the plugin source with the BOM stripped, line endings normalized to LF,
 * and every `//@signature` line removed. The `//@signature-key` line stays in the payload,
 * so the key is bound to the signature.
 *
 * Use `util/signPlugin.mjs` to generate keys and sign plugins.
 */

export type PluginSignatureStatus =
    | { state: 'unsigned' }
    | { state: 'valid', publicKey: string, fingerprint: string }
    // Signed, but this environment cannot verify it (e.g. Web Crypto is unavailable on insecure origins)
    | { state: 'unverifiable', publicKey: string, fingerprint: string, reason: string }
    | { state: 'invalid', reason: string, publicKey?: string, fingerprint?: string }

const signatureLineRegex = /^\/\/@signature[ \t]/
const signatureKeyLineRegex = /^\/\/@signature-key[ \t]/
const base64Regex = /^[A-Za-z0-9+/_-]+={0,2}$/

const P256_RAW_PUBLIC_KEY_LENGTH = 65
const P256_SIGNATURE_LENGTH = 64

function normalizeSource(code: string) {
    return code.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

/**
 * Returns the exact text that is signed: the source without `//@signature` lines.
 */
export function canonicalizePluginSource(code: string): string {
    return normalizeSource(code)
        .split('\n')
        .filter((line) => !signatureLineRegex.test(line))
        .join('\n')
}

function decodeBase64(value: string): Uint8Array | null {
    if (!base64Regex.test(value)) {
        return null
    }
    try {
        const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
        }
        return bytes
    } catch {
        return null
    }
}

function hasSubtleCrypto() {
    return typeof crypto !== 'undefined' && !!crypto.subtle
}

/**
 * Short human-readable identifier of a signing key, e.g. `3f2a 9c01 b7e4 55d0`.
 */
export async function getKeyFingerprint(publicKey: string): Promise<string> {
    const bytes = decodeBase64(publicKey)
    if (!bytes || !hasSubtleCrypto()) {
        return publicKey.slice(0, 16)
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
    const hex = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')
    return hex.match(/.{4}/g).join(' ')
}

export async function verifyPluginSignature(code: string): Promise<PluginSignatureStatus> {
    const lines = normalizeSource(code).split('\n')
    const signatureLines = lines.filter((line) => signatureLineRegex.test(line))
    const keyLines = lines.filter((line) => signatureKeyLineRegex.test(line))

    if (signatureLines.length === 0 && keyLines.length === 0) {
        return { state: 'unsigned' }
    }
    if (signatureLines.length !== 1 || keyLines.length !== 1) {
        return { state: 'invalid', reason: 'A signed plugin must have exactly one //@signature line and one //@signature-key line.' }
    }

    const publicKey = keyLines[0].slice('//@signature-key'.length).trim()
    const signature = signatureLines[0].slice('//@signature'.length).trim()
    const fingerprint = await getKeyFingerprint(publicKey)

    const keyBytes = decodeBase64(publicKey)
    if (!keyBytes || keyBytes.length !== P256_RAW_PUBLIC_KEY_LENGTH || keyBytes[0] !== 0x04) {
        return { state: 'invalid', reason: 'Malformed //@signature-key.', publicKey, fingerprint }
    }
    const signatureBytes = decodeBase64(signature)
    if (!signatureBytes || signatureBytes.length !== P256_SIGNATURE_LENGTH) {
        return { state: 'invalid', reason: 'Malformed //@signature.', publicKey, fingerprint }
    }

    if (!hasSubtleCrypto()) {
        return { state: 'unverifiable', reason: 'Web Crypto is not available in this environment (insecure origin?).', publicKey, fingerprint }
    }

    try {
        const key = await crypto.subtle.importKey(
            'raw',
            keyBytes as BufferSource,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify']
        )
        const ok = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            signatureBytes as BufferSource,
            new TextEncoder().encode(canonicalizePluginSource(code)) as BufferSource
        )
        if (!ok) {
            return { state: 'invalid', reason: 'Signature does not match the plugin code. The plugin may have been modified after signing.', publicKey, fingerprint }
        }
        return { state: 'valid', publicKey, fingerprint }
    } catch (error) {
        return { state: 'invalid', reason: `Failed to verify signature: ${(error as Error).message}`, publicKey, fingerprint }
    }
}

/**
 * Checks whether replacing a plugin signed as `previous` with code signed as `next` keeps the same signer.
 * Returns null when allowed, or a reason when the signer changed or the signature was removed.
 */
export function checkSignerContinuity(previous: PluginSignatureStatus, next: PluginSignatureStatus): string | null {
    if (previous.state !== 'valid' && previous.state !== 'unverifiable') {
        return null
    }
    if (next.state === 'unsigned') {
        return 'The installed version is signed, but the new version is not signed.'
    }
    if (next.state === 'invalid') {
        return next.reason
    }
    if (next.publicKey !== previous.publicKey) {
        return `The new version is signed with a different key (${next.fingerprint}) than the installed version (${previous.fingerprint}).`
    }
    return null
}
