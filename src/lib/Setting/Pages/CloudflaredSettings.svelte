<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import { language } from "src/lang";
    import { isNodeServer } from "src/ts/platform";
    import { alertError } from "src/ts/alert";
    import { getNodeServerProxyAuth } from "src/ts/storage/nodeStorage";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { CloudIcon, CopyIcon, CheckIcon, ExternalLinkIcon } from "@lucide/svelte";

    type CloudflaredStatus = {
        supported: boolean
        platform: string
        installed: boolean
        version: string
        installedVersion: string
        phase: 'idle' | 'downloading' | 'starting' | 'running' | 'stopping'
        running: boolean
        url: string
        error: string
    }

    const TERMS_URL = "https://www.cloudflare.com/website-terms/"
    const TERMS_ACCEPTED_KEY = "risu-cloudflared-terms-accepted"

    const t = language.cloudflaredTunnel

    let status = $state<CloudflaredStatus | null>(null)
    let latestVersion = $state('')
    let busy = $state(false)
    let showTerms = $state(false)
    let copied = $state(false)
    let qrDataUrl = $state('')
    let pollTimer: ReturnType<typeof setInterval> | null = null

    const tunnelState = $derived<'closed' | 'opening' | 'open'>(
        status?.running ? (status.url ? 'open' : 'opening') : 'closed'
    )

    const hasUpdate = $derived(
        !!status?.installedVersion && !!latestVersion && status.installedVersion !== latestVersion
    )

    async function call<T = CloudflaredStatus>(method: 'GET' | 'POST', endpoint: string, body?: object): Promise<T> {
        const res = await fetch(`/api/cloudflared/${endpoint}`, {
            method,
            headers: {
                'risu-auth': await getNodeServerProxyAuth(),
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        })
        const data = await res.json().catch(() => ({}))
        if (data && typeof data.phase === 'string') {
            status = data
        }
        if (!res.ok) {
            throw new Error(data?.error || `Request failed (${res.status})`)
        }
        return data as T
    }

    async function refresh() {
        try {
            await call('GET', 'status')
        } catch (error) {
            console.error(error)
        }
    }

    async function checkLatest() {
        try {
            const data = await call<{ latest: string }>('GET', 'latest')
            latestVersion = data.latest
        } catch (error) {
            console.warn('cloudflared update check failed:', error)
        }
    }

    async function run(fn: () => Promise<unknown>) {
        if (busy) return
        busy = true
        try {
            await fn()
        } catch (error) {
            alertError(error instanceof Error ? error.message : String(error))
        } finally {
            busy = false
        }
    }

    function install() {
        run(async () => {
            await call('POST', 'install')
            await checkLatest()
        })
    }

    function openTunnel() {
        // Show the Quick Tunnel terms until the user has agreed once.
        if (localStorage.getItem(TERMS_ACCEPTED_KEY) !== 'true') {
            showTerms = true
            return
        }
        run(() => call('POST', 'start', { acceptTerms: true }))
    }

    function agreeAndOpen() {
        localStorage.setItem(TERMS_ACCEPTED_KEY, 'true')
        showTerms = false
        run(() => call('POST', 'start', { acceptTerms: true }))
    }

    function closeTunnel() {
        run(() => call('POST', 'stop'))
    }

    async function copyUrl() {
        if (!status?.url) return
        await navigator.clipboard.writeText(status.url)
        copied = true
        setTimeout(() => { copied = false }, 1500)
    }

    $effect(() => {
        const url = status?.url
        if (!url) {
            qrDataUrl = ''
            return
        }
        import('qrcode').then((QRCode) => {
            const { size, data } = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules
            qrDataUrl = roundedQrSvg(size, (r, c) => r >= 0 && c >= 0 && r < size && c < size && data[r * size + c] === 1)
        })
    })

    // Renders a QR matrix as an SVG with rounded modules and rounded finder patterns.
    function roundedQrSvg(size: number, on: (r: number, c: number) => boolean): string {
        const R = 0.5
        const inFinder = (r: number, c: number) =>
            (r < 7 && c < 7) || (r < 7 && c >= size - 7) || (r >= size - 7 && c < 7)
        const dark = (r: number, c: number) => on(r, c) && !inFinder(r, c)
        let d = ''
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                if (!dark(r, c)) continue
                const up = dark(r - 1, c), down = dark(r + 1, c), left = dark(r, c - 1), right = dark(r, c + 1)
                const tl = !up && !left ? R : 0
                const tr = !up && !right ? R : 0
                const br = !down && !right ? R : 0
                const bl = !down && !left ? R : 0
                // Bleed slightly into neighbours so joined modules have no hairline seams.
                const e = 0.02
                const x0 = c - (left ? e : 0), x1 = c + 1 + (right ? e : 0)
                const y0 = r - (up ? e : 0), y1 = r + 1 + (down ? e : 0)
                d += `M${x0 + tl} ${y0}H${x1 - tr}`
                    + (tr ? `A${tr} ${tr} 0 0 1 ${x1} ${y0 + tr}` : '')
                    + `V${y1 - br}`
                    + (br ? `A${br} ${br} 0 0 1 ${x1 - br} ${y1}` : '')
                    + `H${x0 + bl}`
                    + (bl ? `A${bl} ${bl} 0 0 1 ${x0} ${y1 - bl}` : '')
                    + `V${y0 + tl}`
                    + (tl ? `A${tl} ${tl} 0 0 1 ${x0 + tl} ${y0}` : '')
                    + 'Z'
            }
        }
        let finders = ''
        for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
            finders += `<rect x="${fc + 0.5}" y="${fr + 0.5}" width="6" height="6" rx="1.8" fill="none" stroke="#000" stroke-width="1"/>`
            finders += `<rect x="${fc + 2}" y="${fr + 2}" width="3" height="3" rx="0.9"/>`
        }
        const m = 1.5
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-m} ${-m} ${size + m * 2} ${size + m * 2}">`
            + `<rect x="${-m}" y="${-m}" width="${size + m * 2}" height="${size + m * 2}" fill="#fff"/>`
            + `<path d="${d}"/>${finders}</svg>`
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    }

    onMount(async () => {
        if (!isNodeServer) return
        // Only reads state; never downloads or opens anything by itself.
        await refresh()
        if (status?.installed) {
            checkLatest()
        }
        pollTimer = setInterval(() => {
            if (status && (status.running || status.phase !== 'idle')) {
                refresh()
            }
        }, 2000)
    })

    onDestroy(() => {
        if (pollTimer) clearInterval(pollTimer)
    })
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{t.title}</h2>
<span class="text-textcolor2 text-sm mb-4">{t.desc}</span>

{#if !isNodeServer}
    <div class="text-textcolor2 text-sm">{t.nodeOnly}</div>
{:else if !status}
    <div class="text-textcolor2 text-sm">...</div>
{:else if !status.supported}
    <div class="text-textcolor2 text-sm">{t.unsupported(status.platform)}</div>
{:else}
    <div class="w-full max-w-2xl rounded-md border border-darkborderc overflow-hidden">
        <!-- Binary: slim strip -->
        <div class="flex items-center gap-2 px-4 py-2 bg-darkbg text-xs text-textcolor2 border-b border-darkborderc min-h-10">
            {#if status.phase === 'downloading'}
                <span>{t.downloading}</span>
            {:else if !status.installed}
                <span>{t.notInstalled}</span>
                <button class="ml-auto shrink-0 text-textcolor hover:underline disabled:opacity-50" onclick={install} disabled={busy}>{t.download}</button>
            {:else}
                <span class="min-w-0 truncate whitespace-nowrap">
                    cloudflared {status.installedVersion}{#if hasUpdate}<span class="text-textcolor">{' · '}{t.updateAvailable(latestVersion)}</span>{:else if latestVersion}{' · '}{t.latest}{/if}
                </span>
                {#if hasUpdate}
                    <button class="ml-auto shrink-0 text-textcolor hover:underline disabled:opacity-50" onclick={install} disabled={busy || status.running}>{t.update}</button>
                {/if}
            {/if}
        </div>

        <!-- Tunnel row -->
        <div class="flex items-center gap-3 px-4 py-3">
            <div class="relative w-9 h-9 shrink-0 rounded-full bg-textcolor/5 flex items-center justify-center">
                <CloudIcon size={18} />
                <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-bgcolor"
                    class:bg-green-500={tunnelState === 'open'}
                    class:bg-yellow-500={tunnelState === 'opening'}
                    class:bg-gray-500={tunnelState === 'closed'}
                ></span>
            </div>
            <div class="flex-1 min-w-0 flex flex-col">
                <span class="text-sm font-semibold">
                    {tunnelState === 'open' ? t.statusOpen : tunnelState === 'opening' ? t.statusOpening : t.statusClosed}
                </span>
                <span class="text-xs text-textcolor2 truncate">
                    {#if tunnelState === 'open'}
                        {status.url.replace('https://', '')}
                    {:else if !status.installed}
                        {t.needBinary}
                    {:else}
                        {t.closedHint}
                    {/if}
                </span>
            </div>
            {#if status.running}
                <Button size="sm" styled="danger" onclick={closeTunnel} disabled={busy || status.phase === 'stopping'}>{t.close}</Button>
            {:else if !showTerms}
                <Button size="sm" onclick={openTunnel} disabled={busy || !status.installed || status.phase !== 'idle'}>{t.open}</Button>
            {/if}
        </div>

        <!-- Terms (first open only) -->
        {#if showTerms && !status.running}
            <div class="px-4 py-3 border-t border-darkborderc flex flex-col gap-2 bg-darkbg/50">
                <span class="text-sm font-semibold">{t.termsTitle}</span>
                <ul class="list-disc pl-4 text-xs text-textcolor2 flex flex-col gap-0.5">
                    {#each t.termsLimits as item}
                        <li>{item}</li>
                    {/each}
                </ul>
                <div class="flex items-center gap-2 mt-1">
                    <a class="text-xs underline text-textcolor2 hover:text-textcolor" href={TERMS_URL} target="_blank" rel="noopener noreferrer">{t.termsLink}</a>
                    <div class="ml-auto flex gap-2">
                        <Button size="sm" styled="outlined" onclick={() => { showTerms = false }}>{t.cancel}</Button>
                        <Button size="sm" onclick={agreeAndOpen} disabled={busy}>{t.agreeAndOpen}</Button>
                    </div>
                </div>
            </div>
        {/if}

        <!-- QR + URL -->
        {#if tunnelState === 'open'}
            <div class="px-4 py-3 border-t border-darkborderc flex flex-col sm:flex-row gap-4 sm:items-center">
                {#if qrDataUrl}
                    <img src={qrDataUrl} alt="QR" class="w-36 h-36 shrink-0 rounded-lg bg-white self-center sm:self-auto" />
                {/if}
                <div class="flex-1 min-w-0 flex flex-col gap-2">
                    <span class="text-xs text-textcolor2">{t.scanHint}</span>
                    <div class="flex items-stretch rounded-md border border-darkborderc bg-darkbg overflow-hidden">
                        <span class="flex-1 min-w-0 px-4 py-3 text-lg sm:text-xl font-semibold font-mono [overflow-wrap:anywhere] leading-snug select-all">{#each status.url.split(/(?=\.)/) as part}<wbr />{part}{/each}</span>
                        <button class="px-3 border-l border-darkborderc text-textcolor2 hover:text-textcolor hover:bg-textcolor/5" title={copied ? t.copied : t.copy} onclick={copyUrl}>
                            {#if copied}<CheckIcon size={18} />{:else}<CopyIcon size={18} />{/if}
                        </button>
                        <a class="px-3 border-l border-darkborderc text-textcolor2 hover:text-textcolor hover:bg-textcolor/5 flex items-center" title={t.openLink} href={status.url} target="_blank" rel="noopener noreferrer">
                            <ExternalLinkIcon size={18} />
                        </a>
                    </div>
                </div>
            </div>
        {/if}

        {#if status.error}
            <div class="px-4 py-2 border-t border-darkborderc text-xs text-draculared">{status.error}</div>
        {/if}
    </div>

    <span class="text-xs text-textcolor2 mt-2">
        {t.termsFooter}<a class="underline hover:text-textcolor" href={TERMS_URL} target="_blank" rel="noopener noreferrer">{t.termsShort}</a>
    </span>
{/if}
