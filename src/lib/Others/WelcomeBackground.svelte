<script lang="ts">
    // Painterly night scene drawn in SVG: a starry sky, a cloud vortex swirling around a small planet,
    // a whale drifting past, and a meadow along the bottom. Seeded so the scene is identical on every load.
    function seeded(seed: number){
        return () => {
            seed |= 0
            seed = seed + 0x6D2B79F5 | 0
            let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
            return ((t ^ t >>> 14) >>> 0) / 4294967296
        }
    }
    const rand = seeded(1013)
    const pick = <T,>(list: T[]) => list[Math.floor(rand() * list.length)]
    const range = (min: number, max: number) => min + rand() * (max - min)

    function star(size: number){
        let d = ''
        for(let i = 0; i < 10; i++){
            const r = i % 2 === 0 ? size : size * 0.45
            const a = Math.PI / 5 * i - Math.PI / 2
            d += `${i === 0 ? 'M' : 'L'} ${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)} `
        }
        return d + 'Z'
    }

    // ---- sky ----
    const SKY = 1200
    const specks = Array.from({ length: 520 }, () => ({
        x: rand() * SKY,
        y: rand() * SKY,
        r: range(0.5, 1.7),
        opacity: range(0.25, 0.9),
    }))
    const skyStars = Array.from({ length: 46 }, () => ({
        x: rand() * SKY,
        y: rand() * SKY,
        d: star(range(3, 7.5)),
        rotate: rand() * 72,
        twinkle: rand() < 0.5,
        delay: rand() * 6,
    }))
    const nebulae = Array.from({ length: 7 }, () => ({
        x: rand() * SKY,
        y: rand() * SKY,
        r: range(140, 300),
        fill: pick(['#1c2b8f', '#24197a', '#123a86', '#2b1f6e']),
    }))

    // ---- vortex ----
    // two spiral arms of brush strokes winding into the center; the outer end of the main arm leaves toward the top right
    const TURNS = 1.5 * Math.PI
    const arms = [-Math.PI / 4 - TURNS, -Math.PI / 4 - TURNS + Math.PI]

    function spiral(arm: number, t: number, offset: number){
        const r = 110 + 640 * Math.pow(t, 1.1) + offset
        const a = arms[arm] + t * TURNS
        return [Math.cos(a) * r, Math.sin(a) * r]
    }

    function stroke(arm: number, t0: number, length: number, offset: number){
        let d = ''
        const steps = 18
        for(let i = 0; i <= steps; i++){
            const t = t0 + length * i / steps
            const wobble = Math.sin(i * 0.9 + offset) * 6
            const [x, y] = spiral(arm, t, offset + wobble)
            d += `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)} `
        }
        return d
    }

    const masses = Array.from({ length: 120 }, () => {
        const arm = rand() < 0.7 ? 0 : 1
        const t = arm === 0 ? range(0.05, 1) : range(0.05, 0.7)
        const spread = arm === 0 ? 130 : 70
        const [x, y] = spiral(arm, t, range(-spread, spread) * (0.6 + t))
        const roll = rand()
        return {
            x, y,
            r: range(55, 135) * (0.5 + t * (arm === 0 ? 0.9 : 0.6)),
            // warm dusk tones close to the center, cool violet further out
            fill: t < 0.3 && roll < 0.35 ? pick(['#6b3a7a', '#86497a', '#9a5a72'])
                : roll < 0.2 ? pick(['#4a43a0', '#5a52b0'])
                : pick(['#1d2470', '#262b7d', '#30318a', '#3a3896', '#2a2370']),
        }
    })

    const strokes = Array.from({ length: 300 }, () => {
        const arm = rand() < 0.7 ? 0 : 1
        const t0 = arm === 0 ? range(0, 0.92) : range(0, 0.6)
        const spread = arm === 0 ? 135 : 65
        const roll = rand()
        const color = roll < 0.06 && t0 < 0.35 ? pick(['#e2a98b', '#f0c9a0'])
            : roll < 0.16 ? pick(['#c9c0f0', '#e4ddfb'])
            : pick(['#4a47a6', '#5b56b6', '#6d66c2', '#837ad0', '#9c92dc'])
        return {
            d: stroke(arm, t0, range(0.08, 0.3), range(-spread, spread) * (0.5 + t0)),
            color,
            width: roll < 0.16 ? range(1.5, 5) : range(6, 28) * (0.6 + t0),
            opacity: roll < 0.16 ? range(0.4, 0.75) : range(0.3, 0.7),
        }
    })

    const dust = Array.from({ length: 700 }, () => {
        const arm = rand() < 0.7 ? 0 : 1
        const t = Math.pow(rand(), 0.8) * (arm === 0 ? 1 : 0.7)
        const [x, y] = spiral(arm, t, range(-150, 150) * (0.4 + t))
        const gold = rand() < 0.62
        return {
            x, y,
            r: range(0.8, 2.6),
            fill: gold ? pick(['#f5c65b', '#ffd98a', '#f3b14a']) : '#eef0ff',
            opacity: range(0.4, 1),
        }
    })

    const vortexStars = Array.from({ length: 24 }, () => {
        const [x, y] = spiral(rand() < 0.7 ? 0 : 1, range(0.05, 0.8), range(-60, 60))
        return { x, y, d: star(range(5, 10)), rotate: rand() * 72 }
    })

    const eyeDust = Array.from({ length: 90 }, () => {
        const a = rand() * Math.PI * 2
        const r = range(120, 175)
        return { x: Math.cos(a) * r, y: Math.sin(a) * r, r: range(0.8, 2.2), opacity: range(0.4, 1) }
    })

    // ---- meadow ----
    const MW = 1600
    const MH = 360
    function meadowHeight(x: number){
        // tall on the far left, low in the middle, a smaller tuft on the right
        return Math.max(40 + 260 * Math.exp(-Math.pow(x / 420, 2)), 30 + 150 * Math.exp(-Math.pow((x - 1420) / 260, 2)))
    }

    const blades = Array.from({ length: 340 }, () => {
        const x = rand() * MW
        const h = meadowHeight(x) * range(0.45, 1.05)
        const lean = range(-0.35, 0.45) * h
        const w = range(4, 9)
        const depth = rand()
        return {
            depth,
            d: `M ${(x - w).toFixed(1)} ${MH} Q ${(x + lean * 0.3).toFixed(1)} ${(MH - h * 0.55).toFixed(1)} ${(x + lean).toFixed(1)} ${(MH - h).toFixed(1)} Q ${(x + lean * 0.3 + w * 0.4).toFixed(1)} ${(MH - h * 0.5).toFixed(1)} ${(x + w).toFixed(1)} ${MH} Z`,
            fill: depth < 0.35 ? pick(['#0c2122', '#0f2a28']) : depth < 0.75 ? pick(['#143a31', '#1a4637', '#1d5040']) : pick(['#245e44', '#2e714f', '#3c8358']),
        }
    }).sort((a, b) => a.depth - b.depth)

    const flowers = Array.from({ length: 34 }, () => {
        const x = rand() < 0.78 ? range(10, 640) : range(1290, 1560)
        const top = MH - meadowHeight(x) * range(0.45, 0.95)
        return {
            x, top,
            sway: range(-14, 14),
            size: range(5, 10),
            kind: rand() < 0.68 ? 'daisy' : 'lavender',
            rotate: rand() * 60,
        }
    })

    const fireflies = Array.from({ length: 22 }, () => ({
        x: rand() < 0.75 ? range(0, 700) : range(1250, 1600),
        y: range(60, 300),
        r: range(1.4, 3),
        delay: rand() * 8,
        duration: range(6, 11),
    }))
</script>

<div class="absolute inset-0 overflow-hidden bg-[#070b2c]" aria-hidden="true">
    <svg class="absolute inset-0 h-full w-full" viewBox="0 0 {SKY} {SKY}" preserveAspectRatio="xMidYMid slice">
        <defs>
            <linearGradient id="welcome-sky" x1="0" y1="0" x2="0.4" y2="1">
                <stop offset="0" stop-color="#060a2a" />
                <stop offset="0.5" stop-color="#0d1658" />
                <stop offset="1" stop-color="#0a1040" />
            </linearGradient>
            <filter id="welcome-nebula" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="70" />
            </filter>
        </defs>
        <rect width={SKY} height={SKY} fill="url(#welcome-sky)" />
        <g filter="url(#welcome-nebula)" opacity="0.7">
            {#each nebulae as cloud}
                <circle cx={cloud.x} cy={cloud.y} r={cloud.r} fill={cloud.fill} />
            {/each}
        </g>
        {#each specks as speck}
            <circle cx={speck.x} cy={speck.y} r={speck.r} fill="#dbe4ff" opacity={speck.opacity} />
        {/each}
    </svg>
    <!-- twinkling stars live in their own layer so their animation doesn't repaint the blurred nebulae -->
    <svg class="absolute inset-0 h-full w-full" viewBox="0 0 {SKY} {SKY}" preserveAspectRatio="xMidYMid slice">
        {#each skyStars as s}
            <path class:twinkle={s.twinkle} d={s.d} fill="#f5c65b" transform="translate({s.x} {s.y}) rotate({s.rotate})" style:animation-delay={`${s.delay}s`} />
        {/each}
    </svg>

    <div class="stage absolute">
        <svg class="swirl absolute inset-0 h-full w-full overflow-visible" viewBox="-700 -700 1400 1400">
            <defs>
                <filter id="welcome-cloud" x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur in="SourceGraphic" stdDeviation="14" result="soft" />
                    <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="7" result="noise" />
                    <feDisplacementMap in="soft" in2="noise" scale="90" xChannelSelector="R" yChannelSelector="G" />
                </filter>
                <filter id="welcome-brush" x="-30%" y="-30%" width="160%" height="160%">
                    <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="3" result="noise" />
                    <feDisplacementMap in="SourceGraphic" in2="noise" scale="16" xChannelSelector="R" yChannelSelector="G" result="rough" />
                    <feGaussianBlur in="rough" stdDeviation="1.4" />
                </filter>
                <radialGradient id="welcome-eye">
                    <stop offset="0" stop-color="#f6ead2" />
                    <stop offset="0.42" stop-color="#ead2b4" />
                    <stop offset="0.62" stop-color="#d79b80" stop-opacity="0.75" />
                    <stop offset="0.82" stop-color="#7d5aa6" stop-opacity="0.35" />
                    <stop offset="1" stop-color="#3a3592" stop-opacity="0" />
                </radialGradient>
            </defs>
            <g filter="url(#welcome-cloud)" opacity="0.9">
                {#each masses as mass}
                    <circle cx={mass.x} cy={mass.y} r={mass.r} fill={mass.fill} />
                {/each}
            </g>
            <g filter="url(#welcome-brush)" stroke-linecap="round" stroke-linejoin="round" fill="none">
                {#each strokes as s}
                    <path d={s.d} stroke={s.color} stroke-width={s.width} stroke-opacity={s.opacity} />
                {/each}
            </g>
            {#each dust as speck}
                <circle cx={speck.x} cy={speck.y} r={speck.r} fill={speck.fill} opacity={speck.opacity} />
            {/each}
            {#each vortexStars as s}
                <path d={s.d} fill="#f5c65b" transform="translate({s.x} {s.y}) rotate({s.rotate})" />
            {/each}
        </svg>

        <svg class="absolute inset-0 h-full w-full overflow-visible" viewBox="-700 -700 1400 1400">
            <defs>
                <radialGradient id="welcome-planet" cx="0.35" cy="0.3">
                    <stop offset="0" stop-color="#8fb0ff" />
                    <stop offset="0.6" stop-color="#3f5fd8" />
                    <stop offset="1" stop-color="#1f2c8c" />
                </radialGradient>
                <filter id="welcome-soft-glow" x="-100%" y="-100%" width="300%" height="300%">
                    <feGaussianBlur stdDeviation="6" result="blur" />
                    <feMerge>
                        <feMergeNode in="blur" />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
            </defs>

            <circle r="190" fill="url(#welcome-eye)" />
            <g class="eye-spin">
                {#each eyeDust as speck}
                    <circle cx={speck.x} cy={speck.y} r={speck.r} fill="#f3b14a" opacity={speck.opacity} />
                {/each}
            </g>

            <g class="planet" filter="url(#welcome-soft-glow)">
                <g transform="rotate(-22)">
                    <path d="M -64 0 A 64 15 0 0 1 64 0" fill="none" stroke="#9fb3ff" stroke-width="5" opacity="0.85" />
                </g>
                <circle r="38" fill="url(#welcome-planet)" />
                <path d="M -24 -14 Q -8 -24 12 -20" fill="none" stroke="#c7d6ff" stroke-width="3" stroke-linecap="round" opacity="0.5" />
                <path d="M -30 6 Q -6 0 26 8" fill="none" stroke="#2a3aa8" stroke-width="4" stroke-linecap="round" opacity="0.6" />
                <g transform="rotate(-22)">
                    <path d="M -64 0 A 64 15 0 0 0 64 0" fill="none" stroke="#c4d0ff" stroke-width="5" />
                </g>
            </g>

            <g class="whale">
                <g transform="translate(-58 96) rotate(-16)">
                    <path d="M 40 2 C 38 -13 14 -20 -8 -16 C -24 -13 -36 -6 -46 -3 L -60 -15 C -57 -8 -55 -3 -53 0 C -55 3 -57 8 -60 15 L -46 3 C -37 8 -24 15 -4 15 C 16 15 38 13 40 2 Z" fill="#141b5e" />
                    <path d="M 6 8 C 2 14 -6 20 -14 22 C -8 16 -4 12 -2 8 Z" fill="#141b5e" />
                    <circle cx="26" cy="-3" r="1.8" fill="#e8ecff" />
                </g>
            </g>
        </svg>
    </div>

    <svg class="meadow absolute bottom-0 left-0 w-full" viewBox="0 0 {MW} {MH}" preserveAspectRatio="xMinYMax slice">
        <defs>
            <filter id="welcome-firefly" x="-300%" y="-300%" width="700%" height="700%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                </feMerge>
            </filter>
        </defs>
        {#each blades as blade}
            <path d={blade.d} fill={blade.fill} />
        {/each}
        {#each flowers as flower}
            <path d="M {flower.x} {MH} Q {flower.x + flower.sway * 0.3} {(MH + flower.top) / 2} {flower.x + flower.sway} {flower.top}" fill="none" stroke="#2e6b4a" stroke-width="2" />
            <g transform="translate({flower.x + flower.sway} {flower.top}) rotate({flower.rotate})">
                {#if flower.kind === 'daisy'}
                    {#each [0, 45, 90, 135, 180, 225, 270, 315] as angle}
                        <ellipse cx={flower.size * 0.9} rx={flower.size * 0.75} ry={flower.size * 0.3} fill="#eef0f7" transform="rotate({angle})" />
                    {/each}
                    <circle r={flower.size * 0.45} fill="#f5c65b" />
                {:else}
                    {#each [0, 1, 2, 3, 4] as i}
                        <circle cx={i % 2 === 0 ? -2 : 2} cy={-i * flower.size * 0.7} r={flower.size * 0.42} fill={i % 2 === 0 ? '#8b7cf6' : '#a99bff'} />
                    {/each}
                {/if}
            </g>
        {/each}
        <g filter="url(#welcome-firefly)">
            {#each fireflies as fly}
                <circle class="firefly" cx={fly.x} cy={fly.y} r={fly.r} fill="#ffd98a" style:animation-delay={`${fly.delay}s`} style:animation-duration={`${fly.duration}s`} />
            {/each}
        </g>
    </svg>

    <div class="grain absolute inset-0"></div>
</div>

<style>
    /* the vortex sits above the bottom sheet on phones, and right of the modal on desktop */
    .stage{
        left: 52%;
        top: 25%;
        width: max(150vmin, 36rem);
        aspect-ratio: 1;
        translate: -50% -50%;
    }
    @media (min-width: 1024px) {
        .stage{
            left: 68%;
            top: 40%;
            width: max(118vmin, 54rem);
        }
    }

    .meadow{
        height: clamp(9rem, 32vh, 22rem);
    }

    /* the filtered layers are rasterized once and only rotated as a whole */
    .swirl{
        will-change: transform;
        animation: spin 240s linear infinite;
    }
    .eye-spin{
        animation: spin 90s linear infinite;
    }
    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }

    .whale{
        animation: swim 9s ease-in-out infinite;
    }
    @keyframes swim {
        0%, 100% {
            transform: translate(0, 0);
        }
        50% {
            transform: translate(10px, -8px);
        }
    }

    .planet{
        animation: bob 7s ease-in-out infinite;
    }
    @keyframes bob {
        0%, 100% {
            transform: translateY(0);
        }
        50% {
            transform: translateY(-5px);
        }
    }

    .twinkle{
        animation: twinkle 4.5s ease-in-out infinite;
    }
    @keyframes twinkle {
        0%, 100% {
            opacity: 1;
        }
        50% {
            opacity: 0.25;
        }
    }

    .firefly{
        transform-box: fill-box;
        animation-name: drift;
        animation-timing-function: ease-in-out;
        animation-iteration-count: infinite;
        animation-direction: alternate;
    }
    @keyframes drift {
        0% {
            opacity: 0.15;
            transform: translate(0, 0);
        }
        50% {
            opacity: 1;
        }
        100% {
            opacity: 0.3;
            transform: translate(16px, -24px);
        }
    }

    /* fine noise gives the flat fills a painted, paper-like texture */
    .grain{
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
        opacity: 0.1;
        mix-blend-mode: overlay;
    }

    @media (prefers-reduced-motion: reduce) {
        .swirl, .eye-spin, .whale, .planet, .twinkle, .firefly{
            animation: none;
        }
    }
</style>
