// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest'

const fs = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  calls: [] as string[],
  renameError: null as Error | null,
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: { AppData: 14 },
  writeFile: vi.fn(async (path: string, data: Uint8Array, options: { append?: boolean }) => {
    fs.calls.push(`write ${path} ${data.length}${options.append ? ' append' : ''}`)
    const prev = options.append ? (fs.files.get(path) ?? new Uint8Array(0)) : new Uint8Array(0)
    const next = new Uint8Array(prev.length + data.length)
    next.set(prev)
    next.set(data, prev.length)
    fs.files.set(path, next)
  }),
  rename: vi.fn(async (from: string, to: string) => {
    fs.calls.push(`rename ${from} ${to}`)
    if (fs.renameError) throw fs.renameError
    fs.files.set(to, fs.files.get(from)!)
    fs.files.delete(from)
  }),
  copyFile: vi.fn(async (from: string, to: string) => {
    fs.calls.push(`copy ${from} ${to}`)
    fs.files.set(to, fs.files.get(from)!.slice())
  }),
}))

import { replaceFileInChunks } from './tauriWrite'

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251)

beforeEach(() => {
  fs.files.clear()
  fs.calls.length = 0
  fs.renameError = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('replaceFileInChunks', () => {
  test('sends the data in chunks to a temporary file and renames it over the target', async () => {
    fs.files.set('db.bin', bytes(3))
    const data = bytes(25)
    await replaceFileInChunks('db.bin', data, 10)
    expect(fs.calls).toEqual([
      'write db.bin.tmp 10',
      'write db.bin.tmp 10 append',
      'write db.bin.tmp 5 append',
      'rename db.bin.tmp db.bin',
    ])
    expect(fs.files.get('db.bin')).toEqual(data)
    expect(fs.files.has('db.bin.tmp')).toBe(false)
  })

  test('does not send an empty chunk when the size is a multiple of the chunk size', async () => {
    await replaceFileInChunks('db.bin', bytes(20), 10)
    expect(fs.calls).toEqual(['write db.bin.tmp 10', 'write db.bin.tmp 10 append', 'rename db.bin.tmp db.bin'])
  })

  test('writes an empty file', async () => {
    await replaceFileInChunks('db.bin', new Uint8Array(0), 10)
    expect(fs.calls).toEqual(['write db.bin.tmp 0', 'rename db.bin.tmp db.bin'])
    expect(fs.files.get('db.bin')).toEqual(new Uint8Array(0))
  })

  test('truncates a temporary file left over from an earlier write', async () => {
    fs.files.set('db.bin.tmp', bytes(50))
    await replaceFileInChunks('db.bin', bytes(15), 10)
    expect(fs.files.get('db.bin')).toEqual(bytes(15))
  })

  test('copies the temporary file over the target when the rename fails', async () => {
    fs.files.set('db.bin', bytes(3))
    fs.renameError = new Error('os error 5')
    await replaceFileInChunks('db.bin', bytes(15), 10)
    expect(fs.calls.slice(-2)).toEqual(['rename db.bin.tmp db.bin', 'copy db.bin.tmp db.bin'])
    expect(fs.files.get('db.bin')).toEqual(bytes(15))
  })

  test('leaves the target untouched when a chunk fails to write', async () => {
    const { writeFile } = await import('@tauri-apps/plugin-fs')
    const old = bytes(3)
    fs.files.set('db.bin', old)
    vi.mocked(writeFile).mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('disk full'))
    await expect(replaceFileInChunks('db.bin', bytes(25), 10)).rejects.toThrow('disk full')
    expect(fs.files.get('db.bin')).toBe(old)
  })
})
