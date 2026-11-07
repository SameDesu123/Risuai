import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { doLossyCompression } from '../lossyCompression'

// happy-dom neither decodes images nor encodes canvases, so stub both.
class FakeImage {
    width = 100
    height = 50
    onload: (() => void) | null = null
    set src(_: string) {
        queueMicrotask(() => this.onload?.())
    }
}

const toDataURL = vi.fn()
const origCreateElement = document.createElement.bind(document)

beforeEach(() => {
    vi.stubGlobal('Image', FakeImage)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: any) => {
        const el = origCreateElement(tag, options)
        if (tag === 'canvas') {
            ;(el as HTMLCanvasElement).getContext = (() => ({ drawImage: vi.fn() })) as any
            ;(el as HTMLCanvasElement).toDataURL = toDataURL as any
        }
        return el
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    toDataURL.mockReset()
})

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('doLossyCompression', () => {
    test('encodes WebP with a quality inside the 0..1 range', async () => {
        toDataURL.mockReturnValue('data:image/webp;base64,AQID')

        const result = await doLossyCompression(png)

        expect(toDataURL).toHaveBeenCalledTimes(1)
        expect(toDataURL).toHaveBeenCalledWith('image/webp', 0.75)
        expect([...result]).toEqual([1, 2, 3])
    })

    test('falls back to JPEG with the same in-range quality', async () => {
        toDataURL.mockImplementation((type: string) =>
            type === 'image/webp' ? 'data:image/png;base64,AA==' : 'data:image/jpeg;base64,BAUG',
        )

        const result = await doLossyCompression(png)

        expect(toDataURL).toHaveBeenNthCalledWith(2, 'image/jpeg', 0.75)
        expect([...result]).toEqual([4, 5, 6])
    })
})
