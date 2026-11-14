<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import { language } from "src/lang";
    import { isNodeServer } from "src/ts/platform";
    import { alertError } from "src/ts/alert";
    import { getNodeServerProxyAuth } from "src/ts/storage/nodeStorage";
    import Button from "src/lib/UI/GUI/Button.svelte";

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
    <!-- Binary: one small line -->
    <div class="flex items-center gap-2 flex-wrap text-sm text-textcolor2 border-b border-darkborderc pb-3 mb-6">
        {#if status.phase === 'downloading'}
            <span>{t.downloading}</span>
        {:else if !status.installed}
            <span>{t.notInstalled}</span>
            <Button size="sm" onclick={install} disabled={busy}>{t.download}</Button>
        {:else}
            <span>
                cloudflared {status.installedVersion || ''}
                {#if hasUpdate}
                    · <span class="text-textcolor">{t.updateAvailable(latestVersion)}</span>
                {:else if latestVersion}
                    · {t.latest}
                {/if}
            </span>
            {#if hasUpdate}
                <Button size="sm" onclick={install} disabled={busy || status.running}>{t.update}</Button>
            {/if}
        {/if}
    </div>

    <!-- Tunnel -->
    <div class="flex flex-col items-center gap-4 py-4">
        {#if status.running}
            {#if status.url}
                {#if qrDataUrl}
                    <img src={qrDataUrl} alt="QR" class="w-48 h-48 rounded-md bg-white" />
                {/if}
                <div class="flex items-center gap-2 max-w-full">
                    <a class="underline break-all text-center" href={status.url} target="_blank" rel="noopener noreferrer">{status.url}</a>
                    <Button size="sm" styled="outlined" onclick={copyUrl}>{copied ? t.copied : t.copy}</Button>
                </div>
            {:else}
                <span class="text-textcolor2">{t.opening}</span>
            {/if}
            <Button styled="danger" onclick={closeTunnel} disabled={busy || status.phase === 'stopping'}>{t.close}</Button>
        {:else if showTerms}
            <div class="w-full max-w-lg border border-darkborderc rounded-md p-4 flex flex-col gap-3">
                <span class="font-bold">{t.termsTitle}</span>
                <ul class="list-disc pl-5 text-sm text-textcolor2 flex flex-col gap-1">
                    {#each t.termsLimits as item}
                        <li>{item}</li>
                    {/each}
                </ul>
                <a class="underline text-sm text-textcolor2 hover:text-textcolor" href={TERMS_URL} target="_blank" rel="noopener noreferrer">{t.termsLink}</a>
                <div class="flex gap-2 justify-end">
                    <Button size="sm" styled="outlined" onclick={() => { showTerms = false }}>{t.cancel}</Button>
                    <Button size="sm" onclick={agreeAndOpen} disabled={busy}>{t.agreeAndOpen}</Button>
                </div>
            </div>
        {:else}
            <Button size="lg" onclick={openTunnel} disabled={busy || !status.installed || status.phase !== 'idle'}>{t.open}</Button>
            {#if !status.installed}
                <span class="text-xs text-textcolor2">{t.needBinary}</span>
            {/if}
        {/if}
        {#if status.error}
            <span class="text-sm text-draculared">{status.error}</span>
        {/if}
    </div>

    <span class="text-xs text-textcolor2 text-center mt-auto pt-6">
        {t.termsFooter}<a class="underline hover:text-textcolor" href={TERMS_URL} target="_blank" rel="noopener noreferrer">{t.termsLink}</a>
    </span>
{/if}
