#!/usr/bin/env node
// Signs Risuai plugins so users can detect tampering. See "Signing Your Plugin" in plugins.md.
//
//   node util/signPlugin.mjs keygen [private-key.pem]
//   node util/signPlugin.mjs sign <plugin.js> <private-key.pem> [output.js]
//   node util/signPlugin.mjs pubkey <private-key.pem>
//
// Canonicalization must stay in sync with src/ts/plugins/pluginSignature.ts.

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const signatureLineRegex = /^\/\/@signature[ \t]/
const signatureKeyLineRegex = /^\/\/@signature-key[ \t]/

function normalizeSource(code) {
    return code.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

export function canonicalizePluginSource(code) {
    return normalizeSource(code)
        .split('\n')
        .filter((line) => !signatureLineRegex.test(line))
        .join('\n')
}

export function generateSigningKey() {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
}

export function getPublicKey(privateKeyPem) {
    const jwk = createPrivateKey(privateKeyPem).export({ format: 'jwk' })
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
        throw new Error('The signing key must be an EC P-256 private key.')
    }
    const raw = Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(jwk.x, 'base64url'),
        Buffer.from(jwk.y, 'base64url'),
    ])
    return raw.toString('base64')
}

/**
 * Returns the plugin source with fresh `//@signature-key` and `//@signature` lines appended.
 * Existing signature lines are removed first, so signed files can be re-signed.
 */
export function signPluginSource(source, privateKeyPem) {
    let body = normalizeSource(source)
        .split('\n')
        .filter((line) => !signatureLineRegex.test(line) && !signatureKeyLineRegex.test(line))
        .join('\n')
    if (!body.endsWith('\n')) {
        body += '\n'
    }
    const withKey = `${body}//@signature-key ${getPublicKey(privateKeyPem)}\n`
    const signature = sign('sha256', Buffer.from(canonicalizePluginSource(withKey), 'utf-8'), {
        key: createPrivateKey(privateKeyPem),
        dsaEncoding: 'ieee-p1363',
    })
    return `${withKey}//@signature ${signature.toString('base64')}\n`
}

function main(args) {
    const [command, ...rest] = args
    if (command === 'keygen') {
        const out = rest[0] ?? 'plugin-signing-key.pem'
        if (existsSync(out)) {
            throw new Error(`${out} already exists. Refusing to overwrite a signing key.`)
        }
        const pem = generateSigningKey()
        writeFileSync(out, pem, { mode: 0o600 })
        console.log(`Private key written to ${out}. Keep it secret and back it up: updates must be signed with the same key.`)
        console.log(`Public key: ${getPublicKey(pem)}`)
        return
    }
    if (command === 'sign' && rest.length >= 2) {
        const [pluginPath, keyPath, outPath = pluginPath] = rest
        const signed = signPluginSource(readFileSync(pluginPath, 'utf-8'), readFileSync(keyPath, 'utf-8'))
        writeFileSync(outPath, signed)
        console.log(`Signed ${pluginPath} -> ${outPath}`)
        return
    }
    if (command === 'pubkey' && rest.length >= 1) {
        console.log(getPublicKey(readFileSync(rest[0], 'utf-8')))
        return
    }
    console.log([
        'Usage:',
        '  node util/signPlugin.mjs keygen [private-key.pem]',
        '  node util/signPlugin.mjs sign <plugin.js> <private-key.pem> [output.js]',
        '  node util/signPlugin.mjs pubkey <private-key.pem>',
    ].join('\n'))
    process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    try {
        main(process.argv.slice(2))
    } catch (error) {
        console.error(error.message)
        process.exitCode = 1
    }
}
