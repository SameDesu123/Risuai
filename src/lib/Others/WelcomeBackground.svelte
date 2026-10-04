<script lang="ts">
    import { onMount } from 'svelte'
    import { buildEdgeTrees, buildScene, MILKY_WAY_TINTS, MOON, SCENE_HEIGHT } from 'src/ts/gui/welcomeScene'

    // the stage overhangs the screen a little so the layers can drift without showing their edges.
    // the window size stands in until it is measured, so the first frame is already laid out about right
    let width = $state(window.innerWidth)
    let height = $state(window.innerHeight)

    const aspect = $derived(width > 0 && height > 0 ? width / height : 16 / 9)
    // the scene is always shown at full height; a wider screen just sees more of it to the sides
    const vw = $derived(Math.round(SCENE_HEIGHT * Math.min(aspect, 4.4)))
    // beside the modal on wide screens; on narrow ones above it, left of where Airisu stands
    const moonX = $derived(Math.round(vw * (aspect < 1 ? 0.4 : 0.7)))
    const from = $derived(Math.floor((-moonX - 300) / 400) * 400)
    const to = $derived(Math.ceil((vw - moonX + 300) / 400) * 400)
    const scene = $derived(buildScene(from, to))
    const edgeTrees = $derived(buildEdgeTrees(-moonX, vw - moonX, aspect >= 1))
    const meteors = $derived([
        { x: -moonX + vw * 0.3, y: 70, delay: 3, duration: 13 },
        // on narrow screens this one would fall right across the moon
        ...(aspect < 1 ? [] : [{ x: -moonX + vw * 0.94, y: 36, delay: 10, duration: 19 }]),
    ])

    const fireflyColors = ['#fde68a', '#99f6e4', '#f9a8d4']
    const flowerColors = [['#f472b6', '#fce7f3'], ['#2dd4bf', '#ccfbf1']]

    // nearer layers sway and lean toward the mouse further than distant ones, which is what sells the depth.
    // both only move whole layers with plain pixel values, so the compositor does the work without repainting
    const motion = window.matchMedia('(prefers-reduced-motion: no-preference)')
    const layers = new Map<SVGSVGElement, number>()

    function parallax(node: SVGSVGElement, depth: number){
        layers.set(node, depth)
        const reach = depth * 12
        const sway = motion.matches ? node.animate([
            { transform: `translateX(${-reach}px)` },
            { transform: `translateX(${reach}px)` },
        ], { duration: 32000, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' }) : null
        return {
            destroy(){
                sway?.cancel()
                layers.delete(node)
            }
        }
    }

    onMount(() => {
        const leanable = window.matchMedia('(prefers-reduced-motion: no-preference) and (pointer: fine)')
        const onMove = (e: PointerEvent) => {
            if(e.pointerType !== 'mouse' || !leanable.matches){
                return
            }
            const x = e.clientX / window.innerWidth * 2 - 1
            const y = e.clientY / window.innerHeight * 2 - 1
            for(const [node, depth] of layers){
                node.style.translate = `${(-x * depth * 20).toFixed(1)}px ${(-y * depth * 8).toFixed(1)}px`
            }
        }
        window.addEventListener('pointermove', onMove, { passive: true })
        return () => window.removeEventListener('pointermove', onMove)
    })
</script>

{#snippet forest(index: number)}
    {@const layer = scene.forest[index]}
    <defs>
        <!-- a band of haze at the foot of the trees that thins out again below them -->
        <linearGradient id="wb-fog-{index}" gradientUnits="userSpaceOnUse" x1="0" y1={layer.top} x2="0" y2={layer.base + 70}>
            <stop offset="0" stop-color="#358391" stop-opacity="0" />
            <stop offset={(layer.base - layer.top) / (layer.base + 70 - layer.top)} stop-color="#358391" stop-opacity={layer.fog} />
            <stop offset="1" stop-color="#358391" stop-opacity="0" />
        </linearGradient>
    </defs>
    {#if layer.rim > 0}
        <!-- a moonlit copy of the trees peeks out from behind the dark one on the side facing the moon -->
        <path d={layer.left + layer.right} fill="url(#wb-rim)" />
        <path d={layer.left} fill={layer.fill} transform="translate({-layer.rim} {layer.rim * 0.6})" />
        <path d={layer.right} fill={layer.fill} transform="translate({layer.rim} {layer.rim * 0.6})" />
        <path d={layer.ground} fill={layer.fill} />
    {:else}
        <path d={layer.ground + layer.left + layer.right} fill={layer.fill} />
    {/if}
    {#each layer.mist as puff}
        <ellipse cx={puff.x} cy={puff.y} rx={puff.rx} ry={puff.ry} fill="url(#wb-mist)" opacity={puff.opacity} />
    {/each}
    <rect x={from} y={layer.top} width={to - from} height={layer.base + 70 - layer.top} fill="url(#wb-fog-{index})" />
{/snippet}

<div class="pointer-events-none absolute inset-0 overflow-hidden bg-[#050a1c]" aria-hidden="true">
    <div class="stage" bind:clientWidth={width} bind:clientHeight={height}>
        <!-- paint servers shared by every layer; zero-sized rather than hidden, which would break them -->
        <svg class="absolute h-0 w-0">
            <defs>
                <linearGradient id="wb-sky" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={SCENE_HEIGHT}>
                    <stop offset="0" stop-color="#040817" />
                    <stop offset="0.22" stop-color="#091338" />
                    <stop offset="0.42" stop-color="#10275a" />
                    <stop offset="0.56" stop-color="#17426f" />
                    <stop offset="0.66" stop-color="#1f607c" />
                    <stop offset="0.76" stop-color="#2b8088" />
                    <stop offset="0.9" stop-color="#3a9a96" />
                    <stop offset="1" stop-color="#42a59c" />
                </linearGradient>
                <linearGradient id="wb-swath">
                    <stop offset="0" stop-color="#fff" stop-opacity="0" />
                    <stop offset="0.5" stop-color="#fff" />
                    <stop offset="1" stop-color="#fff" stop-opacity="0" />
                </linearGradient>
                <radialGradient id="wb-horizon">
                    <stop offset="0" stop-color="#7ee0d2" stop-opacity="0.28" />
                    <stop offset="1" stop-color="#7ee0d2" stop-opacity="0" />
                </radialGradient>
                {#each MILKY_WAY_TINTS as tint, i}
                    <radialGradient id="wb-mw-{i}">
                        <stop offset="0" stop-color={tint} />
                        <stop offset="1" stop-color={tint} stop-opacity="0" />
                    </radialGradient>
                {/each}
                <radialGradient id="wb-lane">
                    <stop offset="0" stop-color="#050a20" />
                    <stop offset="1" stop-color="#050a20" stop-opacity="0" />
                </radialGradient>
                <radialGradient id="wb-moon-halo">
                    <stop offset="0" stop-color="#cfe8ff" stop-opacity="0.22" />
                    <stop offset="0.25" stop-color="#b6d6f5" stop-opacity="0.1" />
                    <stop offset="1" stop-color="#b6d6f5" stop-opacity="0" />
                </radialGradient>
                <radialGradient id="wb-moon-glow">
                    <stop offset="0" stop-color="#fff7df" stop-opacity="0.6" />
                    <stop offset="0.35" stop-color="#fff1cc" stop-opacity="0.24" />
                    <stop offset="1" stop-color="#fff1cc" stop-opacity="0" />
                </radialGradient>
                <radialGradient id="wb-moon-surface" cx="0.3" cy="0.7" r="0.85">
                    <stop offset="0" stop-color="#fffef6" />
                    <stop offset="0.6" stop-color="#fbf3d6" />
                    <stop offset="1" stop-color="#eadcb0" />
                </radialGradient>
                <mask id="wb-crescent">
                    <circle r={MOON.r} fill="#fff" />
                    <circle cx={MOON.r * 0.42} cy={-MOON.r * 0.3} r={MOON.r * 0.88} fill="#000" />
                </mask>
                <radialGradient id="wb-glint">
                    <stop offset="0" stop-color="#ffffff" stop-opacity="0.8" />
                    <stop offset="0.15" stop-color="#e0f2fe" stop-opacity="0.35" />
                    <stop offset="1" stop-color="#e0f2fe" stop-opacity="0" />
                </radialGradient>
                <linearGradient id="wb-meteor" x1="0" y1="1" x2="1" y2="0">
                    <stop offset="0" stop-color="#ffffff" />
                    <stop offset="0.15" stop-color="#e0f2fe" stop-opacity="0.7" />
                    <stop offset="1" stop-color="#e0f2fe" stop-opacity="0" />
                </linearGradient>
                <radialGradient id="wb-cloud" gradientUnits="userSpaceOnUse" cx="0" cy={MOON.y} r="950">
                    <stop offset="0" stop-color="#eaf6ff" stop-opacity="0.9" />
                    <stop offset="0.12" stop-color="#c4dcf2" stop-opacity="0.7" />
                    <stop offset="0.35" stop-color="#5a76a8" stop-opacity="0.35" />
                    <stop offset="0.7" stop-color="#2a3d6e" stop-opacity="0.2" />
                    <stop offset="1" stop-color="#1b2a52" stop-opacity="0.14" />
                </radialGradient>
                <filter id="wb-cloud-blur" x="-5%" y="-50%" width="110%" height="200%">
                    <feGaussianBlur stdDeviation="3.5" />
                </filter>
                <!-- moonlit faces fade away from their peak, toward the valley and downhill -->
                {#each [[0, 1], [1, 0]] as [start, end], i}
                    <linearGradient id="wb-mountain-lit-{i}" x1={start} y1="0" x2={end} y2="1">
                        <stop offset="0" stop-color="#b9e6f0" />
                        <stop offset="0.3" stop-color="#b9e6f0" stop-opacity="0.75" />
                        <stop offset="0.8" stop-color="#b9e6f0" stop-opacity="0" />
                    </linearGradient>
                {/each}
                <linearGradient id="wb-haze" gradientUnits="userSpaceOnUse" x1="0" y1="520" x2="0" y2="760">
                    <stop offset="0" stop-color="#4f9fa8" stop-opacity="0" />
                    <stop offset="0.55" stop-color="#4f9fa8" stop-opacity="0.32" />
                    <stop offset="1" stop-color="#4f9fa8" stop-opacity="0" />
                </linearGradient>
                <linearGradient id="wb-beam" gradientUnits="userSpaceOnUse" x1="0" y1={MOON.y + 60} x2="0" y2="920">
                    <stop offset="0" stop-color="#e0f7ff" stop-opacity="0" />
                    <stop offset="0.45" stop-color="#e0f7ff" stop-opacity="0.05" />
                    <stop offset="1" stop-color="#e0f7ff" stop-opacity="0" />
                </linearGradient>
                <filter id="wb-beam-blur" x="-20%" y="-5%" width="140%" height="110%">
                    <feGaussianBlur stdDeviation="12" />
                </filter>
                <radialGradient id="wb-rim" gradientUnits="userSpaceOnUse" cx="0" cy={MOON.y} r="1300">
                    <stop offset="0" stop-color="#c8fff4" stop-opacity="0.95" />
                    <stop offset="0.35" stop-color="#a5ebe3" stop-opacity="0.6" />
                    <stop offset="0.7" stop-color="#7cc8cc" stop-opacity="0.25" />
                    <stop offset="1" stop-color="#7cc8cc" stop-opacity="0.08" />
                </radialGradient>
                <radialGradient id="wb-mist">
                    <stop offset="0" stop-color="#78c4c8" />
                    <stop offset="1" stop-color="#78c4c8" stop-opacity="0" />
                </radialGradient>
                <radialGradient id="wb-clearing">
                    <stop offset="0" stop-color="#b5f7ec" stop-opacity="0.38" />
                    <stop offset="0.5" stop-color="#7de3d8" stop-opacity="0.14" />
                    <stop offset="1" stop-color="#7de3d8" stop-opacity="0" />
                </radialGradient>
                {#each fireflyColors as color, i}
                    <radialGradient id="wb-ff-{i}">
                        <stop offset="0" stop-color={color} />
                        <stop offset="0.18" stop-color={color} stop-opacity="0.9" />
                        <stop offset="0.4" stop-color={color} stop-opacity="0.25" />
                        <stop offset="1" stop-color={color} stop-opacity="0" />
                    </radialGradient>
                    <radialGradient id="wb-bokeh-{i}">
                        <stop offset="0" stop-color={color} stop-opacity="0.32" />
                        <stop offset="0.75" stop-color={color} stop-opacity="0.24" />
                        <stop offset="0.92" stop-color={color} stop-opacity="0.12" />
                        <stop offset="1" stop-color={color} stop-opacity="0" />
                    </radialGradient>
                {/each}
                {#each flowerColors as [color], i}
                    <radialGradient id="wb-bloom-{i}">
                        <stop offset="0" stop-color={color} stop-opacity="0.9" />
                        <stop offset="0.25" stop-color={color} stop-opacity="0.4" />
                        <stop offset="1" stop-color={color} stop-opacity="0" />
                    </radialGradient>
                {/each}
                <radialGradient id="wb-shroom">
                    <stop offset="0" stop-color="#67e8f9" stop-opacity="0.5" />
                    <stop offset="1" stop-color="#67e8f9" stop-opacity="0" />
                </radialGradient>
                <filter id="wb-aurora-blur" x="-10%" y="-40%" width="120%" height="180%">
                    <feGaussianBlur stdDeviation="6" />
                </filter>
                <filter id="wb-facet-blur" x="-10%" y="-10%" width="120%" height="120%">
                    <feGaussianBlur stdDeviation="2.5" />
                </filter>
                <filter id="wb-dof" x="-20%" y="-10%" width="140%" height="120%">
                    <feGaussianBlur stdDeviation="3.5" />
                </filter>
            </defs>
        </svg>

        <svg class="layer" viewBox="0 0 {vw} {SCENE_HEIGHT}" preserveAspectRatio="xMidYMax slice">
            <rect y="-60" width={vw} height={SCENE_HEIGHT + 120} fill="url(#wb-sky)" />
            <g transform="translate({moonX} 0)">
                <ellipse cy="650" rx="1100" ry="300" fill="url(#wb-horizon)" />
                {#each scene.sky.milkyWay as glow}
                    <ellipse cx={glow.x} cy={glow.y} rx={glow.rx} ry={glow.ry} fill="url(#wb-mw-{glow.tint})" opacity={glow.opacity} transform="rotate({scene.sky.milkyWayAngle} {glow.x} {glow.y})" />
                {/each}
                <!-- dark dust lanes split the band -->
                {#each scene.sky.lanes as lane}
                    <ellipse cx={lane.x} cy={lane.y} rx={lane.rx} ry={lane.ry} fill="url(#wb-lane)" opacity={lane.opacity} transform="rotate({scene.sky.milkyWayAngle} {lane.x} {lane.y})" />
                {/each}
                {#each scene.sky.stars as group}
                    <path d={group.d} fill={group.color} opacity={group.opacity} />
                {/each}
                <g transform="translate(0 {MOON.y})">
                    <circle r="340" fill="url(#wb-moon-halo)" />
                    <circle r="150" fill="url(#wb-moon-glow)" />
                    <!-- earthshine keeps the dark side of the moon faintly visible -->
                    <circle r={MOON.r} fill="#7186ad" opacity="0.3" />
                    <g mask="url(#wb-crescent)">
                        <circle r={MOON.r} fill="url(#wb-moon-surface)" />
                        <ellipse cx="-16" cy="12" rx="12" ry="8" fill="#cfc3a2" opacity="0.4" />
                        <ellipse cx="-30" cy="-6" rx="7" ry="10" fill="#cfc3a2" opacity="0.32" />
                        <ellipse cx="-4" cy="30" rx="9" ry="5" fill="#cfc3a2" opacity="0.3" />
                        <circle cx="-26" cy="22" r="3" fill="none" stroke="#d8ccab" stroke-width="1" opacity="0.6" />
                        <circle cx="-36" cy="8" r="2" fill="none" stroke="#d8ccab" stroke-width="0.8" opacity="0.5" />
                    </g>
                </g>
            </g>
        </svg>

        <!-- what twinkles lives on its own layer, so redrawing it every frame never touches the rest of the sky -->
        <svg class="layer sparkles" viewBox="0 0 {vw} {SCENE_HEIGHT}" preserveAspectRatio="xMidYMax slice">
            <g transform="translate({moonX} 0)">
                {#each scene.sky.twinkles as star}
                    <circle class="twinkle" cx={star.x} cy={star.y} r={star.r} fill={star.color} fill-opacity={star.opacity} style:animation-delay="{star.delay}s" style:animation-duration="{star.duration}s" />
                {/each}
                {#each scene.sky.glints as glint}
                    <g transform="translate({glint.x} {glint.y}) rotate({glint.tilt})">
                        <g class="glint" style:animation-delay="{glint.delay}s">
                            <circle r={glint.size} fill="url(#wb-glint)" />
                            <path d="M0 {-glint.size}L0.9 0L0 {glint.size}L-0.9 0ZM{-glint.size * 0.7} 0L0 0.8L{glint.size * 0.7} 0L0 -0.8Z" fill="#f0f9ff" />
                            <circle r="1.4" fill="#ffffff" />
                        </g>
                    </g>
                {/each}
                {#each meteors as meteor}
                    <path class="meteor" d="M{meteor.x} {meteor.y}l150 -87" stroke="url(#wb-meteor)" stroke-width="1.6" stroke-linecap="round" fill="none" style:animation-delay="{meteor.delay}s" style:animation-duration="{meteor.duration}s" />
                {/each}
            </g>
        </svg>

        <svg class="layer aurora" viewBox="0 0 {vw} {SCENE_HEIGHT}" preserveAspectRatio="xMidYMax slice">
            <defs>
                {#each scene.aurora as ribbon, i}
                    <mask id="wb-aurora-rays-{i}" maskUnits="userSpaceOnUse" x={from} y="-100" width={to - from} height={SCENE_HEIGHT + 200}>
                        <rect x={from} y="-100" width={to - from} height={SCENE_HEIGHT + 200} fill="#fff" opacity="0.15" />
                        {#each ribbon.swaths as swath}
                            <rect x={swath.x} y="-100" width={swath.w} height={SCENE_HEIGHT + 200} fill="url(#wb-swath)" opacity={swath.opacity} />
                        {/each}
                        {#each ribbon.rays as ray}
                            <path d={ray.d} fill="#fff" opacity={ray.opacity} />
                        {/each}
                    </mask>
                {/each}
            </defs>
            <g transform="translate({moonX} 0)">
                {#each scene.aurora as ribbon, i}
                    <g filter="url(#wb-aurora-blur)" opacity={i === 0 ? 0.9 : 0.6}>
                        <g mask="url(#wb-aurora-rays-{i})">
                            {#each ribbon.bands as band}
                                <path d={band.d} fill={band.color} opacity={band.opacity} />
                            {/each}
                        </g>
                    </g>
                {/each}
            </g>
        </svg>

        <svg class="layer" use:parallax={0.1} viewBox="0 0 {vw} {SCENE_HEIGHT}" preserveAspectRatio="xMidYMax slice">
            <defs>
                {#each scene.mountains as mountain, i}
                    <clipPath id="wb-mountain-{i}">
                        <path d={mountain.outline} transform="translate(0 1.6)" />
                    </clipPath>
                {/each}
            </defs>
            <g transform="translate({moonX} 0)">
                <path d={scene.clouds} fill="url(#wb-cloud)" filter="url(#wb-cloud-blur)" opacity="0.75" />
                {#each scene.mountains as mountain, i}
                    <!-- a thin moonlit line along the ridge, left uncovered by the body sitting just below it -->
                    <path d={mountain.outline} fill="url(#wb-rim)" opacity="0.55" />
                    <path d={mountain.outline} fill={mountain.fill} transform="translate(0 1.6)" />
                    <g clip-path="url(#wb-mountain-{i})">
                        <path d={mountain.snow} fill="#e6f5ff" opacity={mountain.snowOpacity} />
                        {#each mountain.lit as faces, side}
                            <path d={faces} fill="url(#wb-mountain-lit-{side})" opacity={mountain.litOpacity} filter="url(#wb-facet-blur)" />
                        {/each}
                    </g>
                {/each}
                <rect x={from} y="520" width={to - from} height="300" fill="url(#wb-haze)" />
                <path d={scene.beams} fill="url(#wb-beam)" filter="url(#wb-beam-blur)" />
                {@render forest(0)}
                {@render forest(1)}
            </g>
        </svg>

        <svg class="layer" use:parallax={0.28} viewBox="0 0 {vw} {SCENE_HEIGHT}" preserveAspectRatio="xMidYMax slice">
            <g transform="translate({moonX} 0)">
                {@render forest(2)}
                <!-- the clearing under the moon glows through the nearest trees -->
                <ellipse cy="800" rx="650" ry="230" fill="url(#wb-clearing)" />
            </g>
        </svg>

        <svg class="layer" use:parallax={0.55} viewBox="0 0 {vw} {SCENE_HEIGHT}" preserveAspectRatio="xMidYMax slice">
            <g transform="translate({moonX} 0)">
                {@render forest(3)}
            </g>
        </svg>

        <svg class="layer" use:parallax={1} viewBox="0 0 {vw} {SCENE_HEIGHT}" preserveAspectRatio="xMidYMax slice">
            <g transform="translate({moonX} 0)">
                <path d={edgeTrees} fill="#030a16" filter="url(#wb-dof)" />
                <path d={scene.front.ground + scene.front.grass} fill="#040c1a" />
                <path d={scene.front.stems} fill="none" stroke="#0f2a3f" stroke-width="0.9" />
                {#each scene.front.mushrooms as shroom}
                    <circle cx={shroom.x} cy={shroom.y - shroom.stem} r={shroom.cap * 3.2} fill="url(#wb-shroom)" />
                    <rect x={shroom.x - shroom.width / 2} y={shroom.y - shroom.stem} width={shroom.width} height={shroom.stem} rx={shroom.width / 2} fill="#bdf6ef" opacity="0.85" />
                    <path d="M{shroom.x - shroom.cap} {shroom.y - shroom.stem + 1}a{shroom.cap} {shroom.cap * 0.75} 0 0 1 {shroom.cap * 2} 0Z" fill="#5eead4" />
                {/each}
                {#each scene.front.flowers as flower}
                    <circle cx={flower.x} cy={flower.y} r={flower.r * 6} fill="url(#wb-bloom-{flower.color})" />
                    <circle cx={flower.x} cy={flower.y} r={flower.r} fill={flowerColors[flower.color][1]} />
                {/each}
            </g>
        </svg>

        <svg class="layer" use:parallax={0.75} viewBox="0 0 {vw} {SCENE_HEIGHT}" preserveAspectRatio="xMidYMax slice">
            <g transform="translate({moonX} 0)">
                {#each scene.fireflies as fly}
                    <g transform="translate({fly.x} {fly.y}) rotate({fly.angle}) scale({fly.reach})">
                        <circle class="firefly" r={fly.glow / fly.reach} fill="url(#wb-{fly.look})" style:animation-delay="{fly.delay}s" style:animation-duration="{fly.duration}s" />
                    </g>
                {/each}
            </g>
        </svg>
    </div>
</div>

<style>
    .stage{
        position: absolute;
        inset: -12px -36px;
    }

    .layer{
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        transition: translate 1.4s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .sparkles{
        will-change: transform;
    }

    .aurora{
        transform-origin: 50% 30%;
        animation: aurora-drift 26s ease-in-out infinite alternate, aurora-glow 9s ease-in-out infinite alternate;
    }
    @keyframes aurora-drift {
        from {
            transform: translateX(-36px) scaleY(0.94);
        }
        to {
            transform: translateX(36px) scaleY(1.05);
        }
    }
    @keyframes aurora-glow {
        from {
            opacity: 0.55;
        }
        to {
            opacity: 1;
        }
    }

    .twinkle{
        animation: twinkle 4s ease-in-out infinite;
    }
    @keyframes twinkle {
        0%, 100% {
            opacity: 1;
        }
        50% {
            opacity: 0.2;
        }
    }

    .glint{
        transform-box: fill-box;
        transform-origin: center;
        animation: glint 5s ease-in-out infinite;
    }
    @keyframes glint {
        0%, 100% {
            opacity: 0.95;
            transform: scale(1);
        }
        50% {
            opacity: 0.45;
            transform: scale(0.75);
        }
    }

    .meteor{
        opacity: 0;
        animation: meteor linear infinite;
    }
    @keyframes meteor {
        0%, 90% {
            opacity: 0;
            transform: translate(0, 0);
        }
        91% {
            opacity: 1;
        }
        97%, 100% {
            opacity: 0;
            transform: translate(-280px, 162px);
        }
    }

    .firefly{
        animation-name: firefly;
        animation-timing-function: ease-in-out;
        animation-iteration-count: infinite;
        animation-direction: alternate;
    }
    @keyframes firefly {
        0% {
            opacity: 0.15;
            transform: translate(0, 0);
        }
        45% {
            opacity: 1;
        }
        100% {
            opacity: 0.35;
            transform: translate(0, -26px);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .aurora, .twinkle, .glint, .meteor, .firefly{
            animation: none;
        }
        .layer{
            transition: none;
        }
    }
</style>
