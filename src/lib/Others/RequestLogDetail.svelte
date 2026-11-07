<script lang="ts">
    import {
        CopyIcon, CheckIcon, DownloadIcon, ArrowLeftIcon, EyeIcon, EyeOffIcon, WrapTextIcon, TerminalIcon,
    } from '@lucide/svelte';
    import hljs from 'highlight.js/lib/core';
    import json from 'highlight.js/lib/languages/json';
    import { language } from 'src/lang';
    import { downloadFile } from 'src/ts/globalApi.svelte';
    import { ColorSchemeTypeStore } from 'src/ts/gui/colorscheme';
    import Button from '../UI/GUI/Button.svelte';
    import {
        buildCurl, formatBytes, maskHeaders, maskUrl, prettyJSON, statusTone, summarizeLog,
        type RequestLogEntry, type LogStatusTone, type RequestLogTab,
    } from 'src/ts/requestLogView';

    interface Props {
        log: RequestLogEntry
        tab?: RequestLogTab
        /** Fill the parent's height and scroll internally (modal); otherwise cap the content height. */
        fill?: boolean
        /** Shows a back button on small screens when provided. */
        onBack?: () => void
    }

    let { log, tab = $bindable('messages'), fill = false, onBack }: Props = $props()

    if (!hljs.getLanguage('json')) {
        hljs.registerLanguage('json', json)
    }

    const HIGHLIGHT_LIMIT = 150_000

    let responseView: 'text' | 'raw' = $state('text')
    let wrap = $state(true)
    let revealSecrets = $state(false)
    let copiedKey: string | null = $state(null)

    const summary = $derived(summarizeLog(log))
    const tone = $derived(statusTone(log))
    const shownUrl = $derived(revealSecrets ? log.url : maskUrl(log.url))
    const shownHeader = $derived(revealSecrets ? log.header : maskHeaders(log.header))
    const showText = $derived(responseView === 'text' && summary.outputText !== null)

    // Fall back to the request tab when the body has no recognizable prompt
    $effect(() => {
        if (tab === 'messages' && !summary.messages) {
            tab = 'body'
        }
    })

    const tabText = $derived.by(() => {
        switch (tab) {
            case 'messages':
                return (summary.messages ?? []).map((m) => `[${m.role}]\n${m.text}`).join('\n\n')
            case 'body':
                return prettyJSON(log.body)
            case 'header':
                return prettyJSON(shownHeader)
            case 'response':
                return showText ? summary.outputText! : prettyJSON(log.response)
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

    function download() {
        const data = {
            date: log.date,
            url: shownUrl,
            status: log.status ?? null,
            success: log.success,
            headers: shownHeader,
            body: log.body,
            response: log.response,
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        downloadFile(`request-log-${stamp}.json`, JSON.stringify(data, null, 2))
    }

    const toneText: Record<LogStatusTone, string> = {
        success: 'text-green-500',
        warning: 'text-amber-500',
        error: 'text-red-500',
    }

    function roleText(role: string) {
        switch (role) {
            case 'system': case 'developer': return 'text-purple-500'
            case 'user': return 'text-blue-500'
            case 'assistant': case 'model': return 'text-green-500'
            case 'tool': case 'function': case 'function_call': case 'function_call_output': return 'text-amber-500'
            default: return 'text-textcolor2'
        }
    }

    const tabs = $derived([
        { id: 'messages' as const, label: language.requestLogs.messages, count: summary.messages?.length },
        { id: 'body' as const, label: language.requestLogs.request },
        { id: 'header' as const, label: language.requestLogs.headers },
        { id: 'response' as const, label: language.requestLogs.response },
    ])
</script>

{#snippet iconButton(onclick: () => void, title: string, active: boolean, children: import('svelte').Snippet)}
    <button
        class="p-1.5 rounded-md transition-colors hover:bg-selected {active ? 'text-textcolor' : 'text-textcolor2 hover:text-textcolor'}"
        {onclick}
        {title}
    >
        {@render children()}
    </button>
{/snippet}

<div class="flex flex-col min-w-0 {fill ? 'h-full' : ''}">
    <!-- Summary -->
    <div class="px-4 pt-3 pb-3 flex flex-col gap-2">
        <div class="flex items-center gap-2 min-w-0">
            {#if onBack}
                <button class="md:hidden -ml-1 p-1 text-textcolor2 hover:text-textcolor" onclick={onBack} title={language.requestLogs.back}>
                    <ArrowLeftIcon size={18} />
                </button>
            {/if}
            <span class="font-mono font-bold {toneText[tone]}">{log.status ?? (log.success ? 'OK' : 'ERR')}</span>
            <span class="flex-1 min-w-0 truncate font-mono text-sm text-textcolor" title={shownUrl}>{shownUrl}</span>
            {#snippet urlIcon()}
                {#if copiedKey === 'url'}<CheckIcon size={16} class="text-green-500" />{:else}<CopyIcon size={16} />{/if}
            {/snippet}
            {@render iconButton(() => copy(shownUrl, 'url'), `${language.requestLogs.copy} URL`, false, urlIcon)}
        </div>

        <div class="flex flex-wrap gap-x-5 gap-y-1 text-sm">
            {#if summary.model}
                <span><span class="text-textcolor2">{language.model}</span> <span class="text-amber-500">{summary.model}</span></span>
            {/if}
            <span><span class="text-textcolor2">{language.requestLogs.time}</span> <span class="text-textcolor">{log.date}</span></span>
            <span>
                <span class="text-textcolor2">{language.requestLogs.size}</span>
                <span class="text-textcolor">{formatBytes(summary.bodySize)} / {formatBytes(summary.responseSize)}</span>
            </span>
            {#if summary.stream}
                <span class="text-textcolor2">{language.requestLogs.stream}</span>
            {/if}
            {#if summary.usage}
                <span>
                    <span class="text-textcolor2">{language.tokens}</span>
                    <span class="text-blue-500">{summary.usage.input ?? '?'}</span>
                    <span class="text-textcolor2">→</span>
                    <span class="text-green-500">{summary.usage.output ?? '?'}</span>
                </span>
            {/if}
        </div>

        {#if summary.errorMessage}
            <div class="border-l-2 border-red-500 pl-3 py-1 text-sm text-textcolor whitespace-pre-wrap wrap-break-word max-h-24 overflow-y-auto">{summary.errorMessage}</div>
        {/if}

        <div class="flex flex-wrap items-center gap-2 pt-1">
            {#each tabs as t}
                {#if t.id !== 'messages' || summary.messages}
                    <Button size="sm" selected={tab === t.id} onclick={() => tab = t.id}>
                        {t.label}{#if t.count}<span class="ml-1 text-textcolor2">{t.count}</span>{/if}
                    </Button>
                {/if}
            {/each}

            <div class="flex-1"></div>

            {#if tab === 'response' && summary.outputText !== null}
                <Button size="sm" styled="outlined" onclick={() => responseView = responseView === 'text' ? 'raw' : 'text'}>
                    {responseView === 'text' ? language.requestLogs.raw : language.requestLogs.outputText}
                </Button>
            {/if}
            {#snippet wrapIcon()}<WrapTextIcon size={16} />{/snippet}
            {@render iconButton(() => wrap = !wrap, language.requestLogs.wrap, wrap, wrapIcon)}
            {#snippet eyeIcon()}
                {#if revealSecrets}<EyeIcon size={16} class="text-amber-500" />{:else}<EyeOffIcon size={16} />{/if}
            {/snippet}
            {@render iconButton(
                () => revealSecrets = !revealSecrets,
                revealSecrets ? language.requestLogs.hideSecrets : `${language.requestLogs.showSecrets} — ${language.requestLogs.secretsMasked}`,
                revealSecrets, eyeIcon
            )}
            {#snippet copyIcon()}
                {#if copiedKey === 'tab'}<CheckIcon size={16} class="text-green-500" />{:else}<CopyIcon size={16} />{/if}
            {/snippet}
            {@render iconButton(() => copy(tabText, 'tab'), language.requestLogs.copy, false, copyIcon)}
            {#snippet curlIcon()}
                {#if copiedKey === 'curl'}<CheckIcon size={16} class="text-green-500" />{:else}<TerminalIcon size={16} />{/if}
            {/snippet}
            {@render iconButton(() => copy(buildCurl(log, revealSecrets), 'curl'), language.requestLogs.copyCurl, false, curlIcon)}
            {#snippet downloadIcon()}<DownloadIcon size={16} />{/snippet}
            {@render iconButton(download, language.requestLogs.download, false, downloadIcon)}
        </div>
    </div>

    <!-- Content -->
    <div class="border-t border-darkborderc overflow-auto p-4 {fill ? 'flex-1 min-h-0' : 'max-h-[60vh]'}">
        {#if tab === 'messages' && summary.messages}
            <div class="flex flex-col">
                {#each summary.messages as m, mi}
                    <div class="group py-3 first:pt-0 last:pb-0 {mi > 0 ? 'border-t border-darkborderc/60' : ''}">
                        <div class="flex items-center gap-2 text-sm mb-1">
                            <span class="font-bold capitalize {roleText(m.role)}">{m.role}</span>
                            <span class="text-textcolor2 text-xs">#{mi + 1} · {m.text.length.toLocaleString()} {language.requestLogs.chars}</span>
                            <span class="flex-1"></span>
                            <button
                                class="p-1 rounded-md transition-opacity hover:bg-selected md:opacity-0 md:group-hover:opacity-100 focus:opacity-100 {copiedKey === `msg-${mi}` ? 'text-green-500 md:opacity-100' : 'text-textcolor2 hover:text-textcolor'}"
                                onclick={() => copy(m.text, `msg-${mi}`)}
                                title={language.requestLogs.copy}
                            >
                                {#if copiedKey === `msg-${mi}`}<CheckIcon size={14} />{:else}<CopyIcon size={14} />{/if}
                            </button>
                        </div>
                        <div class="text-sm leading-relaxed text-textcolor {wrap ? 'whitespace-pre-wrap wrap-break-word' : 'whitespace-pre overflow-x-auto'}">{m.text}</div>
                    </div>
                {/each}
            </div>
        {:else if tab === 'response' && showText}
            <div class="text-sm leading-relaxed text-textcolor {wrap ? 'whitespace-pre-wrap wrap-break-word' : 'whitespace-pre overflow-x-auto'}">{summary.outputText}</div>
        {:else}
            <pre class="request-log-code {wrap ? 'wrap' : ''} {$ColorSchemeTypeStore === 'light' ? 'light' : ''}">{@html highlight(tabText)}</pre>
        {/if}
    </div>
</div>

<style>
    /* Theme-aware JSON colors so the code follows Risu's light/dark themes
       instead of the app-wide atom-one-dark palette. */
    .request-log-code {
        --log-key: #e5c07b;
        --log-string: #98c379;
        --log-number: #d19a66;
        --log-literal: #56b6c2;
        margin: 0;
        padding: 0;
        background: transparent;
        color: var(--risu-theme-textcolor);
        font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
        font-size: 0.8rem;
        line-height: 1.6;
        white-space: pre;
        overflow-x: auto;
    }
    .request-log-code.light {
        --log-key: #9a6700;
        --log-string: #1a7f37;
        --log-number: #b35900;
        --log-literal: #0550ae;
    }
    .request-log-code.wrap {
        white-space: pre-wrap;
        word-break: break-all;
    }
    .request-log-code :global(.hljs-attr) { color: var(--log-key); }
    .request-log-code :global(.hljs-string) { color: var(--log-string); }
    .request-log-code :global(.hljs-number) { color: var(--log-number); }
    .request-log-code :global(.hljs-literal) { color: var(--log-literal); }
    .request-log-code :global(.hljs-punctuation) { color: var(--risu-theme-textcolor2); }
</style>
