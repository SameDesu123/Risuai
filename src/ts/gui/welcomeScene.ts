/*
 * Procedural night forest behind the welcome screen.
 *
 * The scene is SCENE_HEIGHT units tall and x is measured from the moon, so it can be shown at any aspect
 * ratio by choosing where the moon sits and how far to each side to draw. Every element is generated in
 * fixed-width slices that each own a seeded random stream, so widening the view only adds slices at the
 * edges and never reshuffles what is already on screen.
 */

export const SCENE_HEIGHT = 1000
export const MOON = { y: 190, r: 42 }

type Rand = () => number
type Wave = [amp: number, freq: number, phase: number]

function mulberry32(seed: number): Rand {
    return () => {
        seed |= 0
        seed = seed + 0x6D2B79F5 | 0
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
        return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
}

function eachSlice(seed: number, width: number, from: number, to: number, fn: (x0: number, rand: Rand) => void){
    for(let i = Math.floor(from / width); i * width < to; i++){
        fn(i * width, mulberry32(Math.imul(seed, 0x9E3779B1) ^ Math.imul(i, 0x85EBCA77)))
    }
}

const round = (n: number) => Math.round(n * 10) / 10
const gauss = (t: number) => Math.exp(-t * t)
// roughly normal, centered on 0 with a spread of about 1
const normal = (rand: Rand) => (rand() + rand() + rand() - 1.5) * 2

function wave(x: number, waves: Wave[]){
    let y = 0
    for(const [amp, freq, phase] of waves){
        y += Math.sin(x * freq + phase) * amp
    }
    return y
}

function ellipse(cx: number, cy: number, rx: number, ry: number){
    return `M${round(cx - rx)} ${round(cy)}a${round(rx)} ${round(ry)} 0 1 0 ${round(rx * 2)} 0a${round(rx)} ${round(ry)} 0 1 0 ${round(-rx * 2)} 0Z`
}

function polyline(points: [number, number][]){
    return points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`).join('')
}

// a spruce silhouette with jagged, slightly drooping branch tiers
function spruce(x: number, ground: number, h: number, rand: Rand, spread = 1){
    const top = ground - h
    const half = h * (0.15 + rand() * 0.07) * spread
    const tiers = Math.max(3, Math.min(14, Math.round(h / 15)))
    const step = h * 0.9 / tiers
    const sides = [1, -1].map((s) => {
        const tiersOut: number[][] = []
        for(let i = 0; i < tiers; i++){
            const t = (i + 1) / tiers
            const tipY = top + h * 0.05 + step * (i + 1) + step * 0.25 * rand()
            const reach = half * (0.16 + 0.84 * t ** 0.9) * (0.78 + rand() * 0.44)
            const notchY = tipY - step * (0.6 + rand() * 0.25)
            tiersOut.push([x + s * reach * (0.26 + rand() * 0.18), notchY, x + s * reach * 0.64, notchY + step * 0.08, x + s * reach, tipY])
        }
        return tiersOut
    })
    const trunk = Math.max(0.8, h * 0.02)
    const [right, left] = sides
    let d = `M${round(x)} ${round(top)}`
    for(const [nx, ny, cx, cy, tx, ty] of right){
        d += `L${round(nx)} ${round(ny)}Q${round(cx)} ${round(cy)} ${round(tx)} ${round(ty)}`
    }
    const lastY = right[right.length - 1][5]
    d += `L${round(x + trunk)} ${round(lastY)}L${round(x + trunk)} ${round(ground)}L${round(x - trunk)} ${round(ground)}L${round(x - trunk)} ${round(lastY)}`
    for(let i = left.length - 1; i >= 0; i--){
        const [nx, ny, cx, cy, tx, ty] = left[i]
        d += `L${round(tx)} ${round(ty)}Q${round(cx)} ${round(cy)} ${round(nx)} ${round(ny)}`
    }
    return d + 'Z'
}

// ---- sky ----

const STAR_COLORS = ['#e0f2fe', '#fef3c7', '#c7d2fe']
// the milky way runs through this point, rising to the right
const MILKY_WAY = { x: -320, y: 120, angle: -21 }

type Twinkle = { x: number, y: number, r: number, color: string, opacity: number, delay: number, duration: number }
type Glint = { x: number, y: number, size: number, tilt: number, delay: number }
type Glow = { x: number, y: number, rx: number, ry: number, opacity: number, tint?: number }

export const MILKY_WAY_TINTS = ['#c4b5fd', '#a5f3fc', '#fbcfe8', '#e0e7ff']

function buildSky(from: number, to: number){
    const buckets = new Map<string, string[]>()
    const twinkles: Twinkle[] = []
    const add = (x: number, y: number, r: number, brightness: number, rand: Rand) => {
        if(Math.hypot(x, y - MOON.y) < MOON.r + 50){
            return
        }
        const color = STAR_COLORS[rand() < 0.62 ? 0 : rand() < 0.5 ? 1 : 2]
        if(r > 1.05 && rand() < 0.4){
            twinkles.push({ x: round(x), y: round(y), r: round(r), color, opacity: round(Math.min(1, brightness + 0.2)), delay: round(-rand() * 8), duration: round(3 + rand() * 4) })
            return
        }
        const level = brightness > 0.66 ? 0.9 : brightness > 0.38 ? 0.6 : 0.3
        const key = `${color} ${level}`
        if(!buckets.has(key)){
            buckets.set(key, [])
        }
        buckets.get(key).push(ellipse(x, y, r, r))
    }

    eachSlice(101, 200, from, to, (x0, rand) => {
        for(let i = 0; i < 26; i++){
            const y = -20 + 680 * rand() ** 1.5
            add(x0 + rand() * 200, y, 0.5 + rand() ** 3 * 1.6, (0.45 + rand() * 0.55) * (1 - y / 900), rand)
        }
    })

    // the band of the milky way, drawn as soft glows along its axis with dense small stars around it
    const slope = Math.tan(MILKY_WAY.angle * Math.PI / 180)
    const bandY = (x: number) => MILKY_WAY.y + (x - MILKY_WAY.x) * slope
    eachSlice(211, 200, from, to, (x0, rand) => {
        for(let i = 0; i < 50; i++){
            const x = x0 + rand() * 200
            const y = bandY(x) + normal(rand) * 46
            if(y > -20 && y < 620){
                add(x, y, 0.4 + rand() ** 4 * 1.1, (0.3 + rand() * 0.6) * (1 - y / 900), rand)
            }
        }
    })
    const milkyWay: Glow[] = []
    const lanes: Glow[] = []
    eachSlice(307, 160, from, to, (x0, rand) => {
        const along = x0 + rand() * 160
        milkyWay.push({ x: round(along), y: round(bandY(along) + normal(rand) * 12), rx: round(160 + rand() * 160), ry: round(40 + rand() * 45), tint: Math.floor(rand() * MILKY_WAY_TINTS.length), opacity: round(0.07 + rand() * 0.08) })
        if(rand() < 0.7){
            const lane = x0 + rand() * 160
            lanes.push({ x: round(lane), y: round(bandY(lane) + normal(rand) * 8), rx: round(110 + rand() * 120), ry: round(10 + rand() * 9), opacity: round(0.14 + rand() * 0.16) })
        }
    })

    const glints: Glint[] = []
    eachSlice(401, 520, from, to, (x0, rand) => {
        if(rand() < 0.6){
            const x = x0 + 40 + rand() * 440
            const y = 30 + rand() * 380
            if(Math.hypot(x, y - MOON.y) > 180){
                glints.push({ x: round(x), y: round(y), size: round(9 + rand() * 9), tilt: Math.round(rand() * 30 - 15), delay: round(-rand() * 6) })
            }
        }
    })

    const stars = [...buckets].map(([key, paths]) => {
        const [color, opacity] = key.split(' ')
        return { color, opacity: Number(opacity), d: paths.join('') }
    })
    return { stars, twinkles, glints, milkyWay, lanes, milkyWayAngle: MILKY_WAY.angle }
}

// ---- aurora ----

type Ribbon = { seed: number, start: number, end: number, base: Wave[], baseY: number, height: Wave[], heightY: number, colors: [string, string] }

const RIBBONS: Ribbon[] = [
    { seed: 503, start: -1900, end: 420, baseY: 340, base: [[30, 0.0036, 0.8], [18, 0.0101, 2.2], [9, 0.023, 1.0]], heightY: 190, height: [[58, 0.0052, 1.4], [24, 0.013, 0.2]], colors: ['#86f5d6', '#8b8cf8'] },
    { seed: 607, start: -1050, end: 1500, baseY: 255, base: [[24, 0.0041, 2.9], [14, 0.012, 0.4], [8, 0.027, 2.0]], heightY: 140, height: [[40, 0.006, 0.3], [18, 0.015, 1.1]], colors: ['#c7b8ff', '#f5a8f0'] },
]

function mix(a: string, b: string, t: number){
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16))
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16))
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

// a curtain is cut into horizontal bands that follow its wavy lower edge, brightest just above the edge
function buildRibbon(ribbon: Ribbon, from: number, to: number){
    const start = Math.max(ribbon.start, from)
    const end = Math.min(ribbon.end, to)
    if(end <= start){
        return { bands: [], swaths: [], rays: [] }
    }
    const xs: number[] = []
    for(let x = start; x <= end; x += 12){
        xs.push(x)
    }
    const span = ribbon.end - ribbon.start
    const edge = xs.map((x) => ribbon.baseY + wave(x, ribbon.base))
    const tall = xs.map((x) => (ribbon.heightY + wave(x, ribbon.height)) * Math.sin(Math.PI * (x - ribbon.start) / span) ** 0.6)
    const levels = 12
    const bands = []
    // the first few bands hang below the lower edge as a faint glow, so the sky under it doesn't read as a dark hill
    for(let k = -3; k < levels; k++){
        const f0 = k / levels
        const f1 = (k + 1) / levels
        const upper = xs.map((x, i) => [x, edge[i] - tall[i] * f1] as [number, number])
        const lower = xs.map((x, i) => [x, edge[i] - tall[i] * f0] as [number, number]).reverse()
        const mid = (f0 + f1) / 2
        bands.push({
            d: polyline([...upper, ...lower]) + 'Z',
            color: mix(ribbon.colors[0], ribbon.colors[1], Math.min(1, Math.max(0, mid) * 1.6)),
            // rises quickly from the lower edge, then fades away toward the top
            opacity: round((mid < 0 ? 0.25 * (1 + mid / 0.25) : Math.min(1, 0.25 + mid / 0.12)) * Math.exp(-Math.max(0, mid) * 3.4) * 100) / 100,
        })
    }
    // the curtain is masked so its brightness wanders along it: broad soft swaths plus thin vertical rays
    const swaths: { x: number, w: number, opacity: number }[] = []
    const rays: { d: string, opacity: number }[] = [0.2, 0.4, 0.65].map((opacity) => ({ d: '', opacity }))
    eachSlice(ribbon.seed, 200, start, end, (x0, rand) => {
        const w = 140 + rand() * 280
        swaths.push({ x: round(x0 + rand() * 200 - w / 2), w: round(w), opacity: round(0.3 + rand() * 0.7) })
        for(let i = 0; i < 12; i++){
            const x = x0 + rand() * 200
            const w = 2 + rand() * 7
            rays[Math.floor(rand() * 3)].d += `M${round(x)} -100h${round(w)}v${SCENE_HEIGHT + 200}h${round(-w)}Z`
        }
    })
    return { bands, swaths, rays }
}

// ---- clouds ----

function cloudStreak(cx: number, cy: number, length: number, thickness: number, rand: Rand){
    let d = ''
    const count = Math.max(4, Math.round(length / 26))
    for(let i = 0; i <= count; i++){
        const t = i / count
        const ry = thickness * Math.sin(Math.PI * t) ** 0.7 * (0.45 + rand() * 0.65) + 1.5
        const rx = ry * (3 + rand() * 4) + 10
        // centers rise with their own size so the streak keeps a flat underside
        d += ellipse(cx - length / 2 + length * t + (rand() - 0.5) * 18, cy - ry * 0.45 + (rand() - 0.5) * thickness * 0.25, rx, ry)
    }
    return d
}

function buildClouds(from: number, to: number){
    // a wisp drifting across the foot of the moon, which is always in view
    let d = cloudStreak(-60, 240, 460, 7, mulberry32(77))
    eachSlice(613, 760, from, to, (x0, rand) => {
        const x = x0 + rand() * 760
        const y = 300 + rand() * 180
        // keep the moon itself mostly clear
        if(rand() < 0.45 && !(Math.abs(x) < 420 && y < 340)){
            d += cloudStreak(x, y, 260 + rand() * 360, 5 + rand() * 6, rand)
        }
    })
    return d
}

// ---- mountains ----

type Range = { seed: number, base: number, height: number, crest: number, fill: string, lit: number, snow: number }

const RANGES: Range[] = [
    { seed: 3, base: 690, height: 360, crest: -520, fill: '#22496a', lit: 0.5, snow: 0.42 },
    { seed: 9, base: 706, height: 220, crest: 460, fill: '#1b3f5f', lit: 0.38, snow: 0.26 },
]

function ridge(x: number, range: Range){
    const seed = range.seed
    let y = 0
    let amp = 1
    let freq = 0.0019
    for(let o = 0; o < 5; o++){
        y += (1 - Math.abs(Math.sin(x * freq + seed * (o + 1.3)))) ** 2 * amp
        amp *= 0.47
        freq *= 2.07
    }
    // one slow swell lifts the range into big peaks around its crest while it sinks behind the trees elsewhere
    return y / 1.87 * (0.45 + 0.55 * (0.5 + 0.5 * Math.cos((x - range.crest) * 0.0011)))
}

function buildMountain(range: Range, from: number, to: number){
    const step = 5
    const pts: [number, number][] = []
    for(let x = from; x <= to; x += step){
        pts.push([x, range.base - range.height * ridge(x, range)])
    }
    const outline = polyline([[from, SCENE_HEIGHT], ...pts, [to, SCENE_HEIGHT]]) + 'Z'

    // peaks are the highest points within their neighbourhood
    const peaks: number[] = []
    const reach = 14
    for(let i = reach; i < pts.length - reach; i++){
        let highest = true
        for(let j = i - reach; j <= i + reach && highest; j++){
            if(pts[j][1] < pts[i][1]){
                highest = false
            }
        }
        if(highest && range.base - pts[i][1] > 40){
            peaks.push(i)
        }
    }

    // each peak gets a moonlit face on the side facing the moon and a snow cap if it is tall enough
    // faces are split by which way they face, so each side can fade away from its own peak
    const lit = ['', '']
    let snow = ''
    const snowLine = range.base - range.height * 0.5
    for(const i of peaks){
        const [px, py] = pts[i]
        const dir = px < 0 ? 1 : -1
        let v = i
        for(let j = i + dir; j >= 0 && j < pts.length && !peaks.includes(j); j += dir){
            if(pts[j][1] > pts[v][1]){
                v = j
            }
        }
        const [vx, vy] = pts[v]
        // moonlight catches the upper slope running from the peak down to the next valley
        const spread = vx - px
        lit[dir > 0 ? 0 : 1] += polyline([[px - dir * 2, py - 60], [vx + dir * 2, vy - 60], [vx - spread * 0.1, vy + 80], [px + spread * 0.25, py + 120]]) + 'Z'
        if(py < snowLine){
            // the lower edge of the snow zigzags, with streaks reaching further down the gullies
            const rand = mulberry32(range.seed * 31 + px)
            const depth = (snowLine - py) * 0.6 + 8
            const w = depth * 1.8
            const edge: [number, number][] = []
            const teeth = 12
            for(let k = 0; k <= teeth; k++){
                const t = k / teeth
                const streak = rand() < 0.2 ? 1.45 : 1
                const reach = depth * (1 - Math.abs(t - 0.5) * 1.4) * (0.7 + rand() * 0.45) * streak
                edge.push([px + w - w * 2 * t + (rand() - 0.5) * w * 0.06, py + Math.max(4, reach)])
            }
            snow += polyline([[px - w, py - 60], [px + w, py - 60], ...edge]) + 'Z'
        }
    }
    return { outline, lit, snow, fill: range.fill, litOpacity: range.lit, snowOpacity: range.snow }
}

// ---- forest ----

type ForestLayer = {
    seed: number
    base: number
    waves: Wave[]
    // how far the ground sinks under the moon, opening a clearing
    dip: number
    heights: [number, number]
    gap: number
    fill: string
    // width of the moonlit rim on the trees, 0 for none
    rim: number
    // haze settling at the foot of the layer
    fog: number
}

const FOREST: ForestLayer[] = [
    { seed: 11, base: 655, waves: [[14, 0.0031, 0.4], [6, 0.011, 1.9]], dip: 0, heights: [24, 50], gap: 10, fill: '#1e4967', rim: 0, fog: 0.34 },
    { seed: 23, base: 706, waves: [[20, 0.0024, 2.1], [8, 0.009, 0.3]], dip: 8, heights: [44, 86], gap: 17, fill: '#173d5b', rim: 1.1, fog: 0.24 },
    { seed: 37, base: 774, waves: [[24, 0.0021, 4.2], [10, 0.008, 2.6]], dip: 20, heights: [82, 148], gap: 28, fill: '#11304f', rim: 1.6, fog: 0.15 },
    { seed: 53, base: 868, waves: [[28, 0.0018, 1.1], [12, 0.007, 5.0]], dip: 40, heights: [160, 292], gap: 50, fill: '#0a213a', rim: 2.4, fog: 0.08 },
]

function groundY(layer: ForestLayer, x: number){
    return layer.base + wave(x, layer.waves) + layer.dip * gauss(x / 430)
}

function buildForestLayer(layer: ForestLayer, from: number, to: number){
    let ground = `M${from} ${SCENE_HEIGHT + 40}`
    for(let x = from; x <= to; x += 16){
        ground += `L${x} ${round(groundY(layer, x))}`
    }
    ground += `L${to} ${SCENE_HEIGHT + 40}Z`

    let left = ''
    let right = ''
    const clearing = layer.dip / 40
    eachSlice(layer.seed, 240, from, to, (x0, rand) => {
        let x = x0 + rand() * layer.gap
        while(x < x0 + 240){
            // fewer and shorter trees in the clearing under the moon
            const open = clearing * gauss(x / 330)
            if(rand() > 0.14 + open * 0.3){
                const [min, max] = layer.heights
                const spire = rand() < 0.12
                const h = (min + rand() * (max - min)) * (1 - open * 0.3) * (spire ? 1.15 : 1)
                const tree = spruce(x, groundY(layer, x) + 5, h, rand, spire ? 0.75 : 1)
                if(x < 0){
                    left += tree
                }
                else{
                    right += tree
                }
            }
            x += layer.gap * (0.5 + rand())
        }
    })

    // little puffs of mist caught between the trees
    const mist: Glow[] = []
    eachSlice(layer.seed + 1, 520, from, to, (x0, rand) => {
        for(let i = 0; i < 2; i++){
            const x = x0 + rand() * 520
            mist.push({ x: round(x), y: round(groundY(layer, x) - 4 + rand() * 18), rx: round(150 + rand() * 230), ry: round(14 + rand() * 18), opacity: round(0.1 + rand() * 0.14) })
        }
    })

    return { ...layer, ground, left, right, mist, top: layer.base - layer.heights[1] * 0.75 }
}

// ---- foreground ----

type Flower = { x: number, y: number, r: number, color: number }
type Mushroom = { x: number, y: number, stem: number, width: number, cap: number }

function frontY(x: number){
    return 944 + wave(x, [[7, 0.0042, 1.3], [3, 0.017, 0.2]])
}

function buildFront(from: number, to: number){
    let ground = `M${from} ${SCENE_HEIGHT + 40}`
    for(let x = from; x <= to; x += 12){
        ground += `L${x} ${round(frontY(x))}`
    }
    ground += `L${to} ${SCENE_HEIGHT + 40}Z`

    let grass = ''
    let stems = ''
    const flowers: Flower[] = []
    const mushrooms: Mushroom[] = []
    eachSlice(701, 160, from, to, (x0, rand) => {
        for(let x = x0 + rand() * 4; x < x0 + 160; x += 2.5 + rand() * 4){
            const y = frontY(x) + 3
            const h = 6 + rand() ** 2 * 20
            const lean = (rand() - 0.5) * 12
            grass += `M${round(x - 1.2)} ${round(y)}Q${round(x + lean * 0.25)} ${round(y - h * 0.6)} ${round(x + lean)} ${round(y - h)}Q${round(x + lean * 0.25 + 0.8)} ${round(y - h * 0.55)} ${round(x + 1.2)} ${round(y)}Z`
        }
        if(rand() < 0.6){
            const center = x0 + rand() * 160
            const color = rand() < 0.55 ? 0 : 1
            const count = 2 + Math.floor(rand() * 4)
            for(let i = 0; i < count; i++){
                const x = center + normal(rand) * 14
                const y = frontY(x) + 2
                const h = 9 + rand() * 22
                const lean = (rand() - 0.5) * 8
                stems += `M${round(x)} ${round(y)}Q${round(x + lean * 0.2)} ${round(y - h * 0.5)} ${round(x + lean)} ${round(y - h)}`
                flowers.push({ x: round(x + lean), y: round(y - h), r: round(2.2 + rand() * 1.8), color })
            }
        }
    })
    eachSlice(809, 420, from, to, (x0, rand) => {
        if(rand() < 0.4){
            const center = x0 + rand() * 420
            const count = 2 + Math.floor(rand() * 2)
            for(let i = 0; i < count; i++){
                const x = center + i * (10 + rand() * 8) - 8
                const stem = 9 + rand() * 6
                mushrooms.push({ x: round(x), y: round(frontY(x) + 2), stem: round(stem), width: round(2.2 + rand() * 1.2), cap: round(7 + rand() * 4) })
            }
        }
    })
    return { ground, grass, stems, flowers, mushrooms }
}

// every firefly drifts the same way in its own frame; turning and scaling that frame sets its direction and distance
type Firefly = { x: number, y: number, glow: number, look: string, angle: number, reach: number, delay: number, duration: number }

function buildFireflies(from: number, to: number){
    const fireflies: Firefly[] = []
    const color = (rand: Rand) => rand() < 0.5 ? 0 : rand() < 0.6 ? 1 : 2
    eachSlice(901, 240, from, to, (x0, rand) => {
        // more of them gather in the glowing clearing under the moon
        const count = 2 + (Math.abs(x0 + 120) < 600 ? 2 : 0)
        for(let i = 0; i < count; i++){
            const y = 560 + rand() ** 0.8 * 400
            const near = (y - 560) / 400
            fireflies.push({ x: round(x0 + rand() * 240), y: round(y), glow: round((1 + near * 2.2 + rand() * 0.8) * 3.5), look: `ff-${color(rand)}`, angle: Math.round((rand() - 0.5) * 130), reach: round(0.5 + near + rand() * 0.5), delay: round(-rand() * 10), duration: round(6 + rand() * 6) })
        }
    })
    // a few drift right past the viewer, big and out of focus
    eachSlice(953, 640, from, to, (x0, rand) => {
        if(rand() < 0.6){
            fireflies.push({ x: round(x0 + rand() * 640), y: round(800 + rand() * 180), glow: round(9 + rand() * 9), look: `bokeh-${color(rand)}`, angle: Math.round((rand() - 0.5) * 130), reach: round(1.4 + rand() * 0.6), delay: round(-rand() * 12), duration: round(10 + rand() * 8) })
        }
    })
    return fireflies
}

// faint shafts of moonlight fanning down through the haze
function buildBeams(){
    const reach = 900
    return ([[-0.5, 60], [-0.22, 35], [0.05, 80], [0.3, 45]] as const).map(([angle, spread]) => {
        const x = Math.sin(angle) * reach
        const y = MOON.y + Math.cos(angle) * reach
        return polyline([[-3, MOON.y], [3, MOON.y], [x + spread, y], [x - spread, y]]) + 'Z'
    }).join('')
}

export function buildScene(from: number, to: number){
    return {
        sky: buildSky(from, to),
        aurora: RIBBONS.map((ribbon) => buildRibbon(ribbon, from, to)),
        clouds: buildClouds(from, to),
        mountains: RANGES.map((range) => buildMountain(range, from, to)),
        forest: FOREST.map((layer) => buildForestLayer(layer, from, to)),
        front: buildFront(from, to),
        fireflies: buildFireflies(from, to),
        beams: buildBeams(),
    }
}

// large, out of focus trees hugging the edges of the view, so they depend on how wide it is
export function buildEdgeTrees(left: number, right: number, tall: boolean){
    const rand = mulberry32(1013)
    return spruce(left - 24, SCENE_HEIGHT + 20, tall ? 820 : 560, rand, 1.25) + spruce(right + 36, SCENE_HEIGHT + 20, tall ? 600 : 430, rand, 1.15)
}
