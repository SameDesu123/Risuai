<script lang="ts">
    import { XIcon, RefreshCwIcon, DownloadIcon, InboxIcon } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { alertStore } from 'src/ts/stores.svelte';
    import { downloadFile, getFetchLogs } from 'src/ts/globalApi.svelte';
    import {
        formatBytes, maskHeaders, maskUrl, statusTone, summarizeLog,
        type RequestLogEntry, type LogStatusTone, type RequestLogTab,
    } from 'src/ts/requestLogView';
    import Button from '../UI/GUI/Button.svelte';
    import TextInput from '../UI/GUI/TextInput.svelte';
    import RequestLogDetail from './RequestLogDetail.svelte';

    let logs: RequestLogEntry[] = $state(getFetchLogs().slice())
    let selected: RequestLogEntry | null = $state(null)
    let filter: 'all' | 'error' = $state('all')
    let query = $state('')
    let tab: RequestLogTab = $state('messages')
    let mobileDetail = $state(false)
    let listEl: HTMLElement | undefined = $state()
    let dialogEl: HTMLElement | undefined = $state()

    // Take focus away from the chat input so keyboard navigation works right away
    $effect(() => {
        dialogEl?.focus()
    })

    const errorCount = $derived(logs.filter((l) => !l.success).length)

    const filtered = $derived.by(() => {
        const q = query.trim().toLowerCase()
        return logs.filter((log) => {
            if (filter === 'error' && log.success) return false
            if (!q) return true
            const s = summarizeLog(log)
            return log.url.toLowerCase().includes(q)
                || (s.model ?? '').toLowerCase().includes(q)
                || String(log.status ?? '').includes(q)
                || log.body.toLowerCase().includes(q)
                || log.response.toLowerCase().includes(q)
        })
    })

    // Keep a valid selection when the list or filter changes
    $effect(() => {
        if (!selected || !filtered.includes(selected)) {
            selected = filtered[0] ?? null
        }
    })

    function close() {
        alertStore.set({ type: 'none', msg: '' })
    }

    function refresh() {
        logs = getFetchLogs().slice()
    }

    function select(log: RequestLogEntry) {
        selected = log
        mobileDetail = true
    }

    function move(delta: number) {
        if (filtered.length === 0) return
        const idx = selected ? filtered.indexOf(selected) : -1
        const next = Math.min(filtered.length - 1, Math.max(0, idx + delta))
        selected = filtered[next]
        listEl?.querySelector(`[data-log-index="${next}"]`)?.scrollIntoView({ block: 'nearest' })
    }

    function downloadAll() {
        const data = logs.map((log) => ({
            date: log.date,
            url: maskUrl(log.url),
            status: log.status ?? null,
            success: log.success,
            headers: maskHeaders(log.header),
            body: log.body,
            response: log.response,
        }))
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        downloadFile(`request-logs-${stamp}.json`, JSON.stringify(data, null, 2))
    }

    function onKeydown(e: KeyboardEvent) {
        const target = e.target as HTMLElement | null
        const typingInModal = !!target && !!dialogEl?.contains(target)
            && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

        if (e.key === 'Escape') {
            if (typingInModal && query) {
                query = ''
            } else if (mobileDetail && window.innerWidth < 768) {
                mobileDetail = false
            } else {
                close()
            }
            e.preventDefault()
            return
        }
        if (typingInModal || e.ctrlKey || e.metaKey || e.altKey) return
        if (e.key === 'ArrowDown' || e.key === 'j') { move(1); e.preventDefault() }
        else if (e.key === 'ArrowUp' || e.key === 'k') { move(-1); e.preventDefault() }
        else if (e.key === '/') {
            dialogEl?.querySelector<HTMLInputElement>('#request-log-search')?.focus()
            e.preventDefault()
        }
        else if (['1', '2', '3', '4'].includes(e.key)) {
            const tabs: RequestLogTab[] = ['messages', 'body', 'header', 'response']
            const t = tabs[Number(e.key) - 1]
            if (t !== 'messages' || (selected && summarizeLog(selected).messages)) tab = t
        }
    }

    const toneText: Record<LogStatusTone, string> = {
        success: 'text-green-500',
        warning: 'text-amber-500',
        error: 'text-red-500',
    }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-1100 bg-black/50 flex justify-center items-center md:p-6" onclick={(e) => { if (e.target === e.currentTarget) close() }}>
    <div
        bind:this={dialogEl}
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        aria-label={language.ShowLog}
        class="outline-hidden bg-darkbg text-textcolor w-full h-full md:max-w-6xl md:h-[88vh] md:rounded-md flex flex-col overflow-hidden"
    >
        <!-- Header -->
        <div class="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-darkborderc">
            <h1 class="text-lg md:text-xl font-bold">{language.ShowLog}</h1>
            <span class="text-textcolor2 text-sm">{logs.length}</span>
            {#if errorCount > 0}
                <span class="hidden md:inline text-red-500 text-sm">· {errorCount} {language.requestLogs.errors}</span>
            {/if}

            <div class="flex-1"></div>

            <!-- On mobile, search and filters drop to their own row below the title -->
            <div class="basis-full h-0 order-1 md:hidden"></div>
            <div class="order-2 flex-1 min-w-0 md:order-none md:flex-none md:w-64">
                <TextInput
                    id="request-log-search"
                    size="sm"
                    fullwidth
                    placeholder={language.requestLogs.search}
                    bind:value={query}
                />
            </div>
            <div class="order-2 md:order-none flex gap-2">
                <Button size="sm" selected={filter === 'all'} onclick={() => filter = 'all'}>{language.requestLogs.all}</Button>
                <Button size="sm" selected={filter === 'error'} onclick={() => filter = 'error'}>{language.requestLogs.errors}</Button>
            </div>
            <div class="flex items-center shrink-0">
                <button class="p-1.5 rounded-md text-textcolor2 hover:text-textcolor hover:bg-selected" onclick={refresh} title={language.requestLogs.refresh}>
                    <RefreshCwIcon size={18} />
                </button>
                <button class="p-1.5 rounded-md text-textcolor2 hover:text-textcolor hover:bg-selected disabled:opacity-40" onclick={downloadAll} disabled={logs.length === 0} title={language.requestLogs.downloadAll}>
                    <DownloadIcon size={18} />
                </button>
                <button class="p-1.5 rounded-md text-textcolor2 hover:text-textcolor hover:bg-selected" onclick={close} title={language.requestLogs.shortcuts}>
                    <XIcon size={20} />
                </button>
            </div>
        </div>

        {#if logs.length === 0}
            <div class="flex-1 flex flex-col items-center justify-center gap-3 text-textcolor2">
                <InboxIcon size={40} class="opacity-50" />
                <span>{language.noRequestLogs}</span>
            </div>
        {:else}
            <div class="flex-1 flex min-h-0">
                <!-- List -->
                <div bind:this={listEl} class="w-full md:w-80 shrink-0 md:border-r border-darkborderc overflow-y-auto p-2 {mobileDetail ? 'hidden md:block' : 'block'}">
                    {#if filtered.length === 0}
                        <div class="text-center text-textcolor2 text-sm py-10">{language.requestLogs.noMatch}</div>
                    {/if}
                    {#each filtered as log, i (log)}
                        {@const s = summarizeLog(log)}
                        {@const active = log === selected}
                        <button
                            data-log-index={i}
                            class="w-full text-left px-3 py-2 rounded-md transition-colors {active ? 'bg-selected' : 'hover:bg-selected/50'}"
                            onclick={() => select(log)}
                        >
                            <div class="flex items-baseline gap-2">
                                <span class="shrink-0 font-mono font-bold text-sm {toneText[statusTone(log)]}">{log.status ?? (log.success ? 'OK' : 'ERR')}</span>
                                <span class="flex-1 min-w-0 truncate text-sm font-semibold text-textcolor" title={s.model ?? s.host}>{s.model ?? s.host}</span>
                                <span class="shrink-0 text-xs text-textcolor2">{log.date}</span>
                            </div>
                            <div class="flex items-baseline gap-2 text-xs text-textcolor2 mt-0.5">
                                <span class="flex-1 min-w-0 truncate font-mono" title={maskUrl(log.url)}>{s.model ? s.host : ''}{s.path}</span>
                                <span class="shrink-0">{formatBytes(s.bodySize)}</span>
                            </div>
                            {#if s.errorMessage}
                                <div class="text-xs text-red-500 truncate mt-0.5" title={s.errorMessage}>{s.errorMessage}</div>
                            {/if}
                        </button>
                    {/each}
                </div>

                <!-- Detail -->
                <div class="flex-1 min-w-0 {mobileDetail ? 'block' : 'hidden md:block'}">
                    {#if selected}
                        <RequestLogDetail log={selected} bind:tab fill onBack={() => mobileDetail = false} />
                    {:else}
                        <div class="h-full flex items-center justify-center text-textcolor2 text-sm">{language.requestLogs.selectLog}</div>
                    {/if}
                </div>
            </div>
        {/if}
    </div>
</div>
