<script lang="ts">
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import {
        CheckIcon,
        ChevronRightIcon,
        CopyIcon,
        ExternalLinkIcon,
        GlobeIcon,
        InfoIcon,
        KeyRoundIcon,
        PlayIcon,
        ShieldAlertIcon,
        SquareIcon,
        ZapIcon,
    } from "@lucide/svelte";
    import { alertError } from "src/ts/alert";
    import {
        getCloudflaredStatus,
        setCloudflaredConfig,
        startCloudflared,
        stopCloudflared,
        type CloudflaredMode,
        type CloudflaredStatus,
    } from "src/ts/cloudflared";

    let status = $state<CloudflaredStatus | null>(null)
    let tokenInput = $state('')
    let busy = $state(false)
    let copied = $state(false)
    let showLogs = $state(false)
    let logBox = $state<HTMLPreElement>()

    const transitioning = $derived(status?.status === 'downloading' || status?.status === 'starting')
    const isActive = $derived(transitioning || status?.status === 'running')

    const modes: { value: CloudflaredMode, icon: typeof ZapIcon, title: string, desc: string }[] = [
        { value: 'quick', icon: ZapIcon, title: language.cloudflaredQuickTunnel, desc: language.cloudflaredQuickTunnelDesc },
        { value: 'token', icon: KeyRoundIcon, title: language.cloudflaredNamedTunnel, desc: language.cloudflaredNamedTunnelDesc },
    ]

    async function refresh() {
        try {
            status = await getCloudflaredStatus()
        } catch (error) {
            console.error(error)
        }
    }

    async function run(action: () => Promise<CloudflaredStatus>) {
        busy = true
        try {
            status = await action()
        } catch (error) {
            alertError(error as Error)
        } finally {
            busy = false
        }
    }

    $effect(() => {
        let stopped = false
        let timer: ReturnType<typeof setTimeout>
        const loop = async () => {
            await refresh()
            if (stopped) {
                return
            }
            // Poll quickly only while the tunnel is transitioning
            const fast = status?.status === 'downloading' || status?.status === 'starting'
            timer = setTimeout(loop, fast ? 1000 : 5000)
        }
        loop()
        return () => {
            stopped = true
            clearTimeout(timer)
        }
    })

    // Keep the log view pinned to the newest line
    $effect(() => {
        void status?.logs.length
        if (logBox) {
            logBox.scrollTop = logBox.scrollHeight
        }
    })

    function statusLabel(s: CloudflaredStatus) {
        switch (s.status) {
            case 'downloading': return language.cloudflaredDownloading
            case 'starting': return language.cloudflaredStarting
            case 'running': return language.cloudflaredRunning
            case 'error': return language.cloudflaredError
            default: return language.cloudflaredStopped
        }
    }

    function statusHint(s: CloudflaredStatus) {
        switch (s.status) {
            case 'downloading': return language.cloudflaredDownloadingHint
            case 'starting': return language.cloudflaredStartingHint
            case 'running': return s.runningMode === 'token' ? language.cloudflaredNamedTunnelRunning : language.cloudflaredQuickRunning
            case 'error': return s.error
            default: return language.cloudflaredIdleHint
        }
    }
</script>

<h2 class="text-2xl font-bold mt-2">{language.cloudflaredTunnel}</h2>
<span class="text-textcolor2 text-sm mt-1 mb-4">{language.cloudflaredDesc}</span>

{#if !status}
    <div class="h-20 rounded-md border border-darkborderc bg-darkbg animate-pulse"></div>
{:else}
    <!-- Status -->
    <div class="flex flex-col gap-3 rounded-md border border-darkborderc bg-darkbg p-4">
        <div class="flex flex-wrap items-center gap-3">
            <div class="flex min-w-0 flex-1 basis-60 items-center gap-3">
                <span class="relative flex h-2.5 w-2.5 shrink-0">
                    {#if transitioning}
                        <span class="absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75 animate-ping"></span>
                    {/if}
                    <span
                        class="relative inline-flex h-2.5 w-2.5 rounded-full"
                        class:bg-green-500={status.status === 'running'}
                        class:bg-amber-400={transitioning}
                        class:bg-draculared={status.status === 'error'}
                        class:bg-textcolor2={status.status === 'stopped'}
                    ></span>
                </span>
                <div class="flex min-w-0 flex-1 flex-col">
                    <span class="font-semibold text-textcolor">{statusLabel(status)}</span>
                    <span
                        class="text-xs break-words"
                        class:text-draculared={status.status === 'error'}
                        class:text-textcolor2={status.status !== 'error'}
                    >
                        {statusHint(status)}
                    </span>
                </div>
            </div>
            {#if isActive}
                <Button styled="outlined" size="sm" className="flex shrink-0 items-center gap-1.5" disabled={busy} onclick={() => run(stopCloudflared)}>
                    <SquareIcon size={14} />
                    {language.cloudflaredStop}
                </Button>
            {:else}
                <Button size="sm" className="flex shrink-0 items-center gap-1.5" disabled={busy} onclick={() => run(startCloudflared)}>
                    <PlayIcon size={14} />
                    {language.cloudflaredStart}
                </Button>
            {/if}
        </div>

        {#if status.url}
            <div class="flex items-center gap-2 rounded-md border border-darkborderc bg-bgcolor py-1.5 pl-3 pr-1.5">
                <GlobeIcon size={16} class="shrink-0 text-textcolor2" />
                <a
                    href={status.url}
                    target="_blank"
                    rel="noreferrer"
                    class="min-w-0 grow truncate font-mono text-sm text-textcolor hover:underline"
                >
                    {status.url.replace(/^https:\/\//, '')}
                </a>
                <button
                    type="button"
                    class="shrink-0 rounded-md p-1.5 text-textcolor2 transition-colors hover:bg-darkbutton hover:text-textcolor"
                    title={copied ? language.copied : language.copy}
                    aria-label={language.copy}
                    onclick={async () => {
                        await navigator.clipboard.writeText(status.url)
                        copied = true
                        setTimeout(() => copied = false, 1500)
                    }}
                >
                    {#if copied}
                        <CheckIcon size={16} class="text-green-500" />
                    {:else}
                        <CopyIcon size={16} />
                    {/if}
                </button>
                <a
                    href={status.url}
                    target="_blank"
                    rel="noreferrer"
                    class="shrink-0 rounded-md p-1.5 text-textcolor2 transition-colors hover:bg-darkbutton hover:text-textcolor"
                    title={language.cloudflaredOpen}
                    aria-label={language.cloudflaredOpen}
                >
                    <ExternalLinkIcon size={16} />
                </a>
            </div>
        {/if}
    </div>

    <!-- Mode -->
    <span class="mt-6 mb-2 font-semibold text-textcolor">{language.cloudflaredModeLabel}</span>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {#each modes as mode}
            {@const selected = status.mode === mode.value}
            <button
                type="button"
                class="flex items-start gap-3 rounded-md border p-3 text-left transition-colors focus:outline-hidden focus:ring-2 focus:ring-borderc enabled:hover:bg-darkbutton disabled:cursor-not-allowed"
                class:border-borderc={selected}
                class:bg-darkbutton={selected}
                class:border-darkborderc={!selected}
                class:opacity-50={isActive && !selected}
                aria-pressed={selected}
                disabled={isActive || busy}
                onclick={() => {
                    if (!selected) {
                        run(() => setCloudflaredConfig({ mode: mode.value }))
                    }
                }}
            >
                <span class="shrink-0 rounded-md bg-bgcolor p-2 text-textcolor">
                    <mode.icon size={18} />
                </span>
                <span class="flex min-w-0 flex-col gap-0.5">
                    <span class="text-sm font-semibold text-textcolor">{mode.title}</span>
                    <span class="text-xs text-textcolor2">{mode.desc}</span>
                </span>
            </button>
        {/each}
    </div>
    {#if isActive}
        <span class="mt-2 text-xs text-textcolor2">{language.cloudflaredModeLocked}</span>
    {/if}

    <!-- Token -->
    {#if status.mode === 'token'}
        <div class="mt-6 flex flex-col gap-1">
            <div class="flex items-center gap-2">
                <span class="font-semibold text-textcolor">{language.cloudflaredToken}</span>
                {#if status.hasToken}
                    <span class="flex items-center gap-1 rounded-full bg-darkbutton px-2 py-0.5 text-xs text-textcolor2">
                        <CheckIcon size={12} />
                        {language.cloudflaredTokenSaved}
                    </span>
                {/if}
            </div>
            <span class="text-xs text-textcolor2">{language.cloudflaredTokenHelp}</span>
            <div class="mt-1 flex gap-2">
                <TextInput hideText bind:value={tokenInput} className="min-w-0 flex-1" placeholder={status.hasToken ? '••••••••••••' : 'eyJh...'} />
                <Button
                    disabled={busy || !tokenInput.trim()}
                    onclick={async () => {
                        await run(() => setCloudflaredConfig({ token: tokenInput }))
                        tokenInput = ''
                    }}
                >
                    {language.cloudflaredSaveToken}
                </Button>
            </div>
        </div>
    {/if}

    <!-- Notices -->
    <div class="mt-6 flex flex-col gap-2">
        {#if status.mode === 'quick'}
            <div class="flex gap-3 rounded-md border border-darkborderc p-3 text-xs text-textcolor2">
                <InfoIcon size={16} class="mt-0.5 shrink-0" />
                <span>
                    {language.cloudflaredQuickNotice}
                    <a href="https://www.cloudflare.com/website-terms/" target="_blank" rel="noreferrer" class="underline hover:text-textcolor">
                        {language.cloudflaredTermsLink}
                    </a>
                </span>
            </div>
        {/if}
        <div class="flex gap-3 rounded-md border border-darkborderc p-3 text-xs text-textcolor2">
            <ShieldAlertIcon size={16} class="mt-0.5 shrink-0" />
            <span>{language.cloudflaredSecurityNotice}</span>
        </div>
    </div>

    <!-- Logs -->
    {#if status.logs.length > 0}
        <button
            type="button"
            class="mt-6 flex w-fit items-center gap-1 text-sm text-textcolor2 transition-colors hover:text-textcolor"
            aria-expanded={showLogs}
            onclick={() => showLogs = !showLogs}
        >
            <ChevronRightIcon size={16} class="transition-transform {showLogs ? 'rotate-90' : ''}" />
            {language.cloudflaredLogs}
            <span class="text-xs">({status.logs.length})</span>
        </button>
        {#if showLogs}
            <pre
                bind:this={logBox}
                class="mt-2 max-h-72 overflow-auto rounded-md border border-darkborderc bg-darkbg p-3 font-mono text-xs whitespace-pre-wrap break-all text-textcolor2"
            >{status.logs.join('\n')}</pre>
        {/if}
    {/if}
{/if}
