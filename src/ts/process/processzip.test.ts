import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../alert', () => ({ alertStore: { set: vi.fn() } }))
vi.mock('../characterCards', () => ({ hubURL: '' }))
vi.mock('../parser/parser.svelte', () => ({ hasher: vi.fn() }))
vi.mock('../util', () => ({ asBuffer: (a: any) => a, Semaphore: class {}, sleep: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({
    saveAsset: vi.fn(),
    AppendableBuffer: class {
        #chunks: number[] = []
        append(data: Uint8Array) {
            this.#chunks.push(...data)
        }
        get buffer() {
            return new Uint8Array(this.#chunks)
        }
    },
}))

import { CharXWriter } from './processzip'

const jpeg = new Uint8Array([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const newWriter = () => new CharXWriter({} as any)

afterEach(() => {
    vi.restoreAllMocks()
})

describe('CharXWriter.writeJpeg', () => {
    test('appends JPEG input as-is without re-encoding', async () => {
        const createElement = vi.spyOn(document, 'createElement')
        const writer = newWriter()

        await writer.writeJpeg(jpeg)

        expect([...writer.apb.buffer]).toEqual([...jpeg])
        expect(createElement).not.toHaveBeenCalledWith('canvas')
    })

    test('re-encodes non-JPEG input to JPEG at quality 1', async () => {
        const encoded = new Uint8Array([0xff, 0xd8, 0xaa, 0xff, 0xd9])
        const toBlob = vi.fn((cb: BlobCallback) => cb(new Blob([encoded], { type: 'image/jpeg' })))
        const origCreateElement = document.createElement.bind(document)
        vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: any) => {
            const el = origCreateElement(tag, options)
            if (tag === 'canvas') {
                ;(el as HTMLCanvasElement).getContext = (() => ({ drawImage: vi.fn() })) as any
                ;(el as HTMLCanvasElement).toBlob = toBlob as any
            }
            if (tag === 'img') {
                ;(el as HTMLImageElement).decode = () => Promise.resolve()
            }
            return el
        })
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake')
        const writer = newWriter()

        await writer.writeJpeg(png)

        expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 1)
        expect([...writer.apb.buffer]).toEqual([...encoded])
    })
})
