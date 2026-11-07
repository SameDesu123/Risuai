<script lang="ts">
    import {
        XIcon, CopyIcon, CheckIcon, SearchIcon, RefreshCwIcon, DownloadIcon,
        ArrowLeftIcon, EyeIcon, EyeOffIcon, WrapTextIcon, TerminalIcon, InboxIcon,
    } from '@lucide/svelte';
    import hljs from 'highlight.js/lib/core';
    import json from 'highlight.js/lib/languages/json';
    import { language } from 'src/lang';
    import { alertStore } from 'src/ts/stores.svelte';
    import { downloadFile, getFetchLogs } from 'src/ts/globalApi.svelte';
    import {
        buildCurl, formatBytes, maskHeaders, maskUrl, prettyJSON, statusTone, summarizeLog,
        type RequestLogEntry,
    } from 'src/ts/requestLogView';

    type Tab = 'messages' | 'body' | 'header' | 'response'

    if (!hljs.getLanguage('json')) {
        hljs.registerLanguage('json', json)
    }

    const HIGHLIGHT_LIMIT = 150_000

    let logs: RequestLogEntry[] = $state(getFetchLogs().slice())
    let selected: RequestLogEntry | null = $state(null)
    let filter: 'all' | 'error' = $state('all')
    let query = $state('')
    let tab: Tab = $state('messages')
    let responseView: 'text' | 'raw' = $state('text')
    let wrap = $state(true)
    let revealSecrets = $state(false)
    let copiedKey: string | null = $state(null)
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

    const summary = $derived(selected ? summarizeLog(selected) : null)

    // Fall back to the request tab when the body has no recognizable prompt
    $effect(() => {
        if (tab === 'messages' && summary && !summary.messages) {
            tab = 'body'
        }
    })

    const shownUrl = $derived(selected ? (revealSecrets ? selected.url : maskUrl(selected.url)) : '')
    const shownHeader = $derived(selected ? (revealSecrets ? selected.header : maskHeaders(selected.header)) : '')

    const tabText = $derived.by(() => {
        if (!selected) return ''
        switch (tab) {
            case 'messages':
                return (summary?.messages ?? []).map((m) => `[${m.role}]\n${m.text}`).join('\n\n')
            case 'body':
                return prettyJSON(selected.body)
            case 'header':
                return prettyJSON(shownHeader)
            case 'response':
                return responseView === 'text' && summary?.outputText !== null && summary?.outputText !== undefined
                    ? summary.outputText
                    : prettyJSON(selected.response)
        }
    })

    function highlight(code: string): string {
        const escaped = () => code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        if (code.length > HIGHLIGHT_LIMIT) return escaped()
        try {
            return hljs.highlight(code, { language: 'json' }).value
        } catch {
            return escaped()
        }
    }

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

    async function copy(text: string, key: string) {
        try {
            await navigator.clipboard.writeText(text)
        } catch {
            const textarea = document.createElement('textarea')
            textarea.value = text
            document.body.appendChild(textarea)
            textarea.select()
            document.execCommand('copy')
            document.body.removeChild(textarea)
        }
        copiedKey = key
        setTimeout(() => {
            if (copiedKey === key) copiedKey = null
        }, 1500)
    }

    function exportable(log: RequestLogEntry) {
        return {
            date: log.date,
            url: revealSecrets ? log.url : maskUrl(log.url),
            status: log.status ?? null,
            success: log.success,
            headers: revealSecrets ? log.header : maskHeaders(log.header),
            body: log.body,
            response: log.response,
        }
    }

    function fileStamp() {
        return new Date().toISOString().replace(/[:.]/g, '-')
    }

    function downloadOne(log: RequestLogEntry) {
        downloadFile(`request-log-${fileStamp()}.json`, JSON.stringify(exportable(log), null, 2))
    }

    function downloadAll() {
        downloadFile(`request-logs-${fileStamp()}.json`, JSON.stringify(logs.map(exportable), null, 2))
    }

    function onKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            if ((e.target as HTMLElement)?.id === 'request-log-search' && query) {
                query = ''
            } else if (mobileDetail && window.innerWidth < 768) {
                mobileDetail = false
            } else {
                close()
            }
            e.preventDefault()
            return
        }
        const target = e.target as HTMLElement | null
        const typingInModal = !!target && !!dialogEl?.contains(target)
            && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        if (typingInModal || e.ctrlKey || e.metaKey || e.altKey) return
        if (e.key === 'ArrowDown' || e.key === 'j') { move(1); e.preventDefault() }
        else if (e.key === 'ArrowUp' || e.key === 'k') { move(-1); e.preventDefault() }
        else if (e.key === '/') { (document.getElementById('request-log-search') as HTMLInputElement)?.focus(); e.preventDefault() }
        else if (['1', '2', '3', '4'].includes(e.key)) {
            const tabs: Tab[] = ['messages', 'body', 'header', 'response']
            const t = tabs[Number(e.key) - 1]
            if (t !== 'messages' || summary?.messages) tab = t
        }
    }

    const toneBadge = {
        success: 'bg-green-600/20 text-green-400 border-green-500/40',
        warning: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
        error: 'bg-red-600/20 text-red-400 border-red-500/40',
    }
    const toneBar = {
        success: 'bg-green-500',
        warning: 'bg-amber-400',
        error: 'bg-red-500',
    }

    function roleClass(role: string) {
        switch (role) {
            case 'system': case 'developer': return 'text-purple-300 bg-purple-500/15 border-purple-500/30'
            case 'user': return 'text-sky-300 bg-sky-500/15 border-sky-500/30'
            case 'assistant': case 'model': return 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30'
            case 'tool': case 'function': case 'function_call': case 'function_call_output':
                return 'text-amber-300 bg-amber-500/15 border-amber-500/30'
            default: return 'text-textcolor2 bg-textcolor/5 border-darkborderc'
        }
    }
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet copyButton(text: string, key: string, label: string)}
    <button
        class="flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-darkborderc transition-colors {copiedKey === key ? 'text-green-400 border-green-500/50' : 'text-textcolor2 hover:text-textcolor hover:bg-textcolor/5'}"
        onclick={() => copy(text, key)}
        title={label}
    >
        {#if copiedKey === key}<CheckIcon size={14} />{:else}<CopyIcon size={14} />{/if}
        <span class="hidden sm:inline">{copiedKey === key ? language.requestLogs.copied : label}</span>
    </button>
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-1100 bg-black/70 flex justify-center items-center md:p-6" onclick={(e) => { if (e.target === e.currentTarget) close() }}>
    <div bind:this={dialogEl} tabindex="-1" role="dialog" aria-modal="true" aria-label={language.ShowLog} class="outline-hidden bg-darkbg text-textcolor w-full h-full md:max-w-7xl md:h-[90vh] md:rounded-xl md:border border-darkborderc shadow-2xl flex flex-col overflow-hidden">

        <!-- Toolbar -->
        <div class="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-darkborderc">
            <h1 class="text-lg font-bold mr-1">{language.ShowLog}</h1>
            <span class="text-xs px-2 py-0.5 rounded-full bg-textcolor/10 text-textcolor2">{logs.length}</span>
            {#if errorCount > 0}
                <span class="text-xs px-2 py-0.5 rounded-full bg-red-600/20 text-red-400">{errorCount} {language.requestLogs.errors}</span>
            {/if}

            <div class="flex-1"></div>

            <div class="relative order-last w-full md:order-none md:w-72">
                <SearchIcon size={14} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-textcolor2 pointer-events-none" />
                <input
                    id="request-log-search"
                    class="w-full pl-8 pr-3 py-1.5 text-sm rounded-md bg-bgcolor border border-darkborderc focus:border-borderc focus:outline-hidden text-textcolor placeholder:text-textcolor2"
                    placeholder={language.requestLogs.search}
                    bind:value={query}
                />
            </div>

            <div class="flex rounded-md border border-darkborderc overflow-hidden text-xs">
                <button class="px-3 py-1.5 transition-colors {filter === 'all' ? 'bg-textcolor/15 text-textcolor' : 'text-textcolor2 hover:bg-textcolor/5'}" onclick={() => filter = 'all'}>{language.requestLogs.all}</button>
                <button class="px-3 py-1.5 border-l border-darkborderc transition-colors {filter === 'error' ? 'bg-red-600/25 text-red-300' : 'text-textcolor2 hover:bg-textcolor/5'}" onclick={() => filter = 'error'}>{language.requestLogs.errors}</button>
            </div>

            <button class="p-1.5 rounded-md text-textcolor2 hover:text-textcolor hover:bg-textcolor/5" onclick={refresh} title={language.requestLogs.refresh}>
                <RefreshCwIcon size={16} />
            </button>
            <button class="p-1.5 rounded-md text-textcolor2 hover:text-textcolor hover:bg-textcolor/5 disabled:opacity-40" onclick={downloadAll} disabled={logs.length === 0} title={language.requestLogs.downloadAll}>
                <DownloadIcon size={16} />
            </button>
            <button class="p-1.5 rounded-md text-textcolor2 hover:text-textcolor hover:bg-textcolor/5" onclick={close} title="Esc">
                <XIcon size={18} />
            </button>
        </div>

        {#if logs.length === 0}
            <div class="flex-1 flex flex-col items-center justify-center gap-3 text-textcolor2">
                <InboxIcon size={40} class="opacity-50" />
                <span>{language.noRequestLogs}</span>
            </div>
        {:else}
            <div class="flex-1 flex min-h-0">

                <!-- List -->
                <div bind:this={listEl} class="w-full md:w-80 lg:w-96 shrink-0 md:border-r border-darkborderc overflow-y-auto {mobileDetail ? 'hidden md:block' : 'block'}">
                    {#if filtered.length === 0}
                        <div class="text-center text-textcolor2 text-sm py-10">{language.requestLogs.noMatch}</div>
                    {/if}
                    {#each filtered as log, i (log)}
                        {@const s = summarizeLog(log)}
                        {@const tone = statusTone(log)}
                        {@const active = log === selected}
                        <button
                            data-log-index={i}
                            class="relative w-full text-left pl-4 pr-3 py-2.5 border-b border-darkborderc/60 transition-colors {active ? 'bg-textcolor/10' : 'hover:bg-textcolor/5'}"
                            onclick={() => select(log)}
                        >
                            <span class="absolute left-0 top-0 bottom-0 w-1 {toneBar[tone]} {active ? 'opacity-100' : 'opacity-50'}"></span>
                            <div class="flex items-center gap-2">
                                <span class="shrink-0 px-1.5 py-0.5 rounded border text-[11px] font-bold font-mono {toneBadge[tone]}">
                                    {log.status ?? (log.success ? 'OK' : 'ERR')}
                                </span>
                                <span class="flex-1 min-w-0 truncate text-sm font-medium" title={s.model ?? s.host}>
                                    {s.model ?? s.host}
                                </span>
                                <span class="shrink-0 text-[11px] text-textcolor2 font-mono">{log.date}</span>
                            </div>
                            <div class="mt-1 flex items-center gap-2 text-[11px] text-textcolor2">
                                <span class="flex-1 min-w-0 truncate font-mono" title={maskUrl(log.url)}>{s.model ? s.host : ''}{s.path}</span>
                                {#if s.stream}<span class="shrink-0 px-1 rounded bg-textcolor/10">{language.requestLogs.stream}</span>{/if}
                                <span class="shrink-0">{formatBytes(s.bodySize)}</span>
                            </div>
                            {#if s.errorMessage}
                                <div class="mt-1 text-[11px] text-red-400 truncate" title={s.errorMessage}>{s.errorMessage}</div>
                            {/if}
                        </button>
                    {/each}
                </div>

                <!-- Detail -->
                <div class="flex-1 min-w-0 flex-col {mobileDetail ? 'flex' : 'hidden md:flex'}">
                    {#if selected && summary}
                        {@const tone = statusTone(selected)}
                        <div class="px-4 pt-3 pb-2 border-b border-darkborderc space-y-2">
                            <div class="flex items-center gap-2">
                                <button class="md:hidden p-1 -ml-1 rounded text-textcolor2 hover:text-textcolor" onclick={() => mobileDetail = false} title={language.requestLogs.back}>
                                    <ArrowLeftIcon size={18} />
                                </button>
                                <span class="px-2 py-0.5 rounded border text-xs font-bold font-mono {toneBadge[tone]}">
                                    {selected.status ?? (selected.success ? 'OK' : 'ERR')}
                                </span>
                                <span class="flex-1 min-w-0 truncate font-mono text-sm" title={shownUrl}>{shownUrl}</span>
                                {@render copyButton(shownUrl, 'url', 'URL')}
                            </div>

                            <div class="flex flex-wrap items-center gap-1.5 text-xs">
                                {#if summary.model}
                                    <span class="px-2 py-0.5 rounded-md bg-textcolor/10 font-mono">{summary.model}</span>
                                {/if}
                                <span class="px-2 py-0.5 rounded-md bg-textcolor/5 text-textcolor2">{selected.date}</span>
                                {#if summary.stream}
                                    <span class="px-2 py-0.5 rounded-md bg-textcolor/5 text-textcolor2">{language.requestLogs.stream}</span>
                                {/if}
                                <span class="px-2 py-0.5 rounded-md bg-textcolor/5 text-textcolor2">↑ {formatBytes(summary.bodySize)}</span>
                                <span class="px-2 py-0.5 rounded-md bg-textcolor/5 text-textcolor2">↓ {formatBytes(summary.responseSize)}</span>
                                {#if summary.usage}
                                    <span class="px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-300 font-mono" title={language.requestLogs.tokens}>
                                        {language.requestLogs.tokens}
                                        {summary.usage.input ?? '?'} → {summary.usage.output ?? '?'}{summary.usage.total !== undefined ? ` (Σ ${summary.usage.total})` : ''}
                                    </span>
                                {/if}
                            </div>

                            {#if summary.errorMessage}
                                <div class="text-sm text-red-300 bg-red-600/10 border border-red-500/30 rounded-md px-3 py-2 whitespace-pre-wrap break-words max-h-24 overflow-y-auto">{summary.errorMessage}</div>
                            {/if}

                            <div class="flex flex-wrap items-center gap-1 pt-1">
                                {#each [
                                    { id: 'messages', label: language.requestLogs.messages, extra: summary.messages ? `${summary.messages.length}` : null, disabled: !summary.messages },
                                    { id: 'body', label: language.requestLogs.request, extra: null, disabled: false },
                                    { id: 'header', label: language.requestLogs.headers, extra: null, disabled: false },
                                    { id: 'response', label: language.requestLogs.response, extra: null, disabled: false },
                                ] as t, ti}
                                    <button
                                        class="px-3 py-1.5 text-sm rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed {tab === t.id ? 'bg-textcolor/15 text-textcolor font-medium' : 'text-textcolor2 hover:bg-textcolor/5 hover:text-textcolor'}"
                                        disabled={t.disabled}
                                        onclick={() => tab = t.id as Tab}
                                        title={`${ti + 1}`}
                                    >
                                        {t.label}{#if t.extra}<span class="ml-1.5 text-[11px] opacity-60">{t.extra}</span>{/if}
                                    </button>
                                {/each}

                                <div class="flex-1"></div>

                                {#if tab === 'response' && summary.outputText !== null}
                                    <div class="flex rounded-md border border-darkborderc overflow-hidden text-xs mr-1">
                                        <button class="px-2 py-1 {responseView === 'text' ? 'bg-textcolor/15' : 'text-textcolor2 hover:bg-textcolor/5'}" onclick={() => responseView = 'text'}>{language.requestLogs.outputText}</button>
                                        <button class="px-2 py-1 border-l border-darkborderc {responseView === 'raw' ? 'bg-textcolor/15' : 'text-textcolor2 hover:bg-textcolor/5'}" onclick={() => responseView = 'raw'}>{language.requestLogs.raw}</button>
                                    </div>
                                {/if}
                                <button
                                    class="p-1.5 rounded-md border border-darkborderc transition-colors {wrap ? 'text-textcolor bg-textcolor/10' : 'text-textcolor2 hover:bg-textcolor/5'}"
                                    onclick={() => wrap = !wrap}
                                    title={language.requestLogs.wrap}
                                >
                                    <WrapTextIcon size={14} />
                                </button>
                                <button
                                    class="p-1.5 rounded-md border transition-colors {revealSecrets ? 'text-amber-300 border-amber-500/50 bg-amber-500/10' : 'text-textcolor2 border-darkborderc hover:bg-textcolor/5'}"
                                    onclick={() => revealSecrets = !revealSecrets}
                                    title={revealSecrets ? language.requestLogs.hideSecrets : language.requestLogs.showSecrets}
                                >
                                    {#if revealSecrets}<EyeIcon size={14} />{:else}<EyeOffIcon size={14} />{/if}
                                </button>
                                {@render copyButton(tabText, `tab-${tab}`, language.requestLogs.copy)}
                                <button
                                    class="flex items-center gap-1 px-2 py-1 rounded-md text-xs border border-darkborderc transition-colors {copiedKey === 'curl' ? 'text-green-400 border-green-500/50' : 'text-textcolor2 hover:text-textcolor hover:bg-textcolor/5'}"
                                    onclick={() => copy(buildCurl(selected!, revealSecrets), 'curl')}
                                    title={revealSecrets ? language.requestLogs.copyCurl : `${language.requestLogs.copyCurl} — ${language.requestLogs.secretsMasked}`}
                                >
                                    {#if copiedKey === 'curl'}<CheckIcon size={14} />{:else}<TerminalIcon size={14} />{/if}
                                    <span class="hidden sm:inline">cURL</span>
                                </button>
                                <button
                                    class="p-1.5 rounded-md border border-darkborderc text-textcolor2 hover:text-textcolor hover:bg-textcolor/5"
                                    onclick={() => downloadOne(selected!)}
                                    title={language.requestLogs.download}
                                >
                                    <DownloadIcon size={14} />
                                </button>
                            </div>
                        </div>

                        <div class="flex-1 min-h-0 overflow-auto p-4">
                            {#if tab === 'messages' && summary.messages}
                                <div class="flex flex-col gap-2">
                                    {#each summary.messages as m, mi}
                                        <div class="rounded-lg border border-darkborderc bg-bgcolor/40">
                                            <div class="flex items-center gap-2 px-3 py-1.5 border-b border-darkborderc/60">
                                                <span class="text-[11px] font-mono text-textcolor2 w-6">#{mi + 1}</span>
                                                <span class="px-2 py-0.5 rounded border text-[11px] font-semibold uppercase tracking-wide {roleClass(m.role)}">{m.role}</span>
                                                <span class="flex-1"></span>
                                                <span class="text-[11px] text-textcolor2">{m.text.length.toLocaleString()} {language.requestLogs.chars}</span>
                                                {@render copyButton(m.text, `msg-${mi}`, language.requestLogs.copy)}
                                            </div>
                                            <div class="px-3 py-2 text-sm leading-relaxed {wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto'}">{m.text}</div>
                                        </div>
                                    {/each}
                                </div>
                            {:else if tab === 'response' && responseView === 'text' && summary.outputText !== null}
                                <div class="rounded-lg border border-darkborderc bg-bgcolor/40 px-3 py-2 text-sm leading-relaxed {wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto'}">{summary.outputText}</div>
                            {:else}
                                <pre class="request-log-code hljs {wrap ? 'wrap' : ''}">{@html highlight(tabText)}</pre>
                            {/if}
                        </div>
                    {:else}
                        <div class="flex-1 flex items-center justify-center text-textcolor2 text-sm">{language.requestLogs.selectLog}</div>
                    {/if}
                </div>
            </div>

            <div class="hidden md:flex items-center gap-4 px-4 py-1.5 border-t border-darkborderc text-[11px] text-textcolor2">
                <span>{language.requestLogs.shortcuts}</span>
                {#if !revealSecrets}<span class="ml-auto">{language.requestLogs.secretsMasked}</span>{/if}
            </div>
        {/if}
    </div>
</div>

<style>
    .request-log-code {
        background-color: #1e2028;
        color: #e0e0e0;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 0.5rem;
        padding: 0.75rem 1rem;
        margin: 0;
        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
        font-size: 0.75rem;
        line-height: 1.55;
        white-space: pre;
        overflow-x: auto;
        min-height: 100%;
    }
    .request-log-code.wrap {
        white-space: pre-wrap;
        word-break: break-all;
    }
</style>
