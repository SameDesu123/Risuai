// WCAG 2.x contrast helpers. Ratios are returned unrounded; compare them
// against thresholds directly rather than after rounding.

export function parseHexColor(hex: string): [number, number, number] {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)
    if (!match) {
        throw new Error(`Invalid hex color: ${hex}`)
    }
    let digits = match[1]
    if (digits.length === 3) {
        digits = digits.split('').map((d) => d + d).join('')
    }
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [number, number, number]
}

function channelToLinear(value: number): number {
    const c = value / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex: string): number {
    const [r, g, b] = parseHexColor(hex).map(channelToLinear)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
    const la = relativeLuminance(a)
    const lb = relativeLuminance(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function meetsContrast(ratio: number, min: number): boolean {
    return ratio >= min
}
