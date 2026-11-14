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
        import('qrcode').then(async (QRCode) => {
            qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 360 })
        })
    })

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
                    cloudflared {status.installedVersion}{#if hasUpdate}<span class="text-textcolor"> · {t.updateAvailable(latestVersion)}</span>{:else if latestVersion} · {t.latest}{/if}
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
                    <img src={qrDataUrl} alt="QR" class="w-32 h-32 shrink-0 rounded-md bg-white p-1 self-center sm:self-auto" />
                {/if}
                <div class="flex-1 min-w-0 flex flex-col gap-2">
                    <span class="text-xs text-textcolor2">{t.scanHint}</span>
                    <div class="flex items-stretch rounded-md border border-darkborderc bg-darkbg overflow-hidden">
                        <span class="flex-1 min-w-0 px-3 py-2 text-sm font-mono truncate select-all">{status.url}</span>
                        <button class="px-3 border-l border-darkborderc text-textcolor2 hover:text-textcolor hover:bg-textcolor/5" title={copied ? t.copied : t.copy} onclick={copyUrl}>
                            {#if copied}<CheckIcon size={16} />{:else}<CopyIcon size={16} />{/if}
                        </button>
                        <a class="px-3 border-l border-darkborderc text-textcolor2 hover:text-textcolor hover:bg-textcolor/5 flex items-center" title={t.openLink} href={status.url} target="_blank" rel="noopener noreferrer">
                            <ExternalLinkIcon size={16} />
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
