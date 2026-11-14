<script lang="ts">
    import { onDestroy, onMount } from "svelte";
    import { language } from "src/lang";
    import { isNodeServer } from "src/ts/platform";
    import { alertConfirm, alertError } from "src/ts/alert";
    import { getNodeServerProxyAuth } from "src/ts/storage/nodeStorage";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";

    type CloudflaredStatus = {
        supported: boolean
        platform: string
        installed: boolean
        version: string
        phase: 'idle' | 'downloading' | 'starting' | 'running' | 'stopping'
        running: boolean
        url: string
        error: string
        logs: string[]
    }

    // Printed verbatim by cloudflared itself whenever a Quick Tunnel is created.
    const OFFICIAL_DISCLAIMER = "Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps"
    const TERMS_URL = "https://www.cloudflare.com/website-terms/"
    const DOCS_URL = "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/"

    const t = language.cloudflaredTunnel

    let status = $state<CloudflaredStatus | null>(null)
    let busy = $state(false)
    let acceptedTerms = $state(false)
    let copied = $state(false)
    let pollTimer: ReturnType<typeof setInterval> | null = null

    async function call(method: 'GET' | 'POST', endpoint: string, body?: object) {
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
        return data as CloudflaredStatus
    }

    async function refresh() {
        try {
            await call('GET', 'status')
        } catch (error) {
            console.error(error)
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
        run(() => call('POST', 'install'))
    }

    function uninstall() {
        run(() => call('POST', 'uninstall'))
    }

    function start() {
        if (!acceptedTerms) return
        run(async () => {
            if (!await alertConfirm(t.confirmStart)) return
            await call('POST', 'start', { acceptTerms: true })
        })
    }

    function stop() {
        run(() => call('POST', 'stop'))
    }

    async function copyUrl() {
        if (!status?.url) return
        await navigator.clipboard.writeText(status.url)
        copied = true
        setTimeout(() => { copied = false }, 1500)
    }

    onMount(() => {
        if (!isNodeServer) return
        // Only reads status; never installs or starts anything by itself.
        refresh()
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
    <div class="border border-darkborderc rounded-md p-4 text-textcolor2">{t.nodeOnly}</div>
{:else if !status}
    <div class="text-textcolor2">...</div>
{:else if !status.supported}
    <div class="border border-darkborderc rounded-md p-4 text-textcolor2">{t.unsupported(status.platform)}</div>
{:else}
    <!-- Binary -->
    <div class="border border-darkborderc rounded-md p-4 mb-4 flex flex-col gap-2">
        <h3 class="text-lg font-bold">{t.binary}</h3>
        <span class="text-sm" class:text-textcolor2={!status.installed}>
            {status.installed ? `${t.installed}${status.version ? ` · ${status.version}` : ''}` : t.notInstalled}
        </span>
        <span class="text-xs text-textcolor2">{t.downloadNotice}</span>
        <div class="flex gap-2 flex-wrap">
            <Button size="sm" onclick={install} disabled={busy || status.running || status.phase === 'downloading'}>
                {status.phase === 'downloading' ? t.downloading : status.installed ? t.redownload : t.download}
            </Button>
            {#if status.installed}
                <Button size="sm" styled="danger" onclick={uninstall} disabled={busy || status.running}>
                    {t.remove}
                </Button>
            {/if}
        </div>
    </div>

    <!-- Terms -->
    <div class="border border-darkborderc rounded-md p-4 mb-4 flex flex-col gap-2">
        <h3 class="text-lg font-bold">{t.terms}</h3>
        <span class="text-sm">{t.termsSummary}</span>
        <ul class="list-disc pl-5 text-sm text-textcolor2 flex flex-col gap-1">
            {#each t.termsLimits as item}
                <li>{item}</li>
            {/each}
        </ul>
        <details class="text-sm">
            <summary class="cursor-pointer text-textcolor2 hover:text-textcolor">{t.officialNotice}</summary>
            <p class="mt-2 p-2 bg-darkbg rounded-md text-xs text-textcolor2 whitespace-pre-wrap break-words">{OFFICIAL_DISCLAIMER}</p>
        </details>
        <div class="flex flex-col gap-1 text-sm">
            <a class="underline text-textcolor2 hover:text-textcolor" href={TERMS_URL} target="_blank" rel="noopener noreferrer">Cloudflare Online Services Terms of Use</a>
            <a class="underline text-textcolor2 hover:text-textcolor" href={DOCS_URL} target="_blank" rel="noopener noreferrer">Cloudflare Quick Tunnels (TryCloudflare)</a>
        </div>
        <div class="mt-2">
            <CheckInput bind:check={acceptedTerms} name={t.accept} />
        </div>
    </div>

    <!-- Tunnel -->
    <div class="border border-darkborderc rounded-md p-4 mb-4 flex flex-col gap-2">
        <h3 class="text-lg font-bold">{t.tunnel}</h3>
        {#if status.running}
            {#if status.url}
                <span class="text-sm text-textcolor2">{t.publicUrl}</span>
                <div class="flex gap-2 items-center flex-wrap">
                    <a class="underline break-all" href={status.url} target="_blank" rel="noopener noreferrer">{status.url}</a>
                    <Button size="sm" styled="outlined" onclick={copyUrl}>{copied ? t.copied : t.copy}</Button>
                </div>
            {:else}
                <span class="text-sm text-textcolor2">{t.starting}</span>
            {/if}
            <div>
                <Button size="sm" styled="danger" onclick={stop} disabled={busy || status.phase === 'stopping'}>{t.stop}</Button>
            </div>
        {:else}
            <span class="text-sm text-textcolor2">{t.stopped}</span>
            <div>
                <Button size="sm" onclick={start} disabled={busy || !status.installed || !acceptedTerms}>{t.start}</Button>
            </div>
        {/if}
        {#if status.error}
            <span class="text-sm text-draculared">{status.error}</span>
        {/if}
    </div>

    <!-- Logs -->
    <details class="border border-darkborderc rounded-md p-4">
        <summary class="cursor-pointer font-bold">{t.logs}</summary>
        <div class="mt-2 flex justify-end">
            <Button size="sm" styled="outlined" onclick={refresh}>{t.refresh}</Button>
        </div>
        <pre class="mt-2 p-2 bg-darkbg rounded-md text-xs text-textcolor2 overflow-x-auto max-h-80 overflow-y-auto">{status.logs.join('\n')}</pre>
    </details>
{/if}
