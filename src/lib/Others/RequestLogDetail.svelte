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
        type RequestLogEntry, type LogStatusTone,
    } from 'src/ts/requestLogView';

    interface Props {
        log: RequestLogEntry
        showHeaders?: boolean
        /** Shows a back button on small screens when provided. */
        onBack?: () => void
    }

    let { log, showHeaders = $bindable(false), onBack }: Props = $props()

    if (!hljs.getLanguage('json')) {
        hljs.registerLanguage('json', json)
    }

    const HIGHLIGHT_LIMIT = 150_000

    let wrap = $state(true)
    let revealSecrets = $state(false)
    let copiedKey: string | null = $state(null)

    const summary = $derived(summarizeLog(log))
    const tone = $derived(statusTone(log))
    const shownUrl = $derived(revealSecrets ? log.url : maskUrl(log.url))
    const shownHeader = $derived(revealSecrets ? log.header : maskHeaders(log.header))
    const headerText = $derived(prettyJSON(shownHeader))

    const panes = $derived([
        { key: 'body', label: language.requestLogs.request, size: summary.bodySize, text: prettyJSON(log.body) },
        { key: 'response', label: language.requestLogs.response, size: summary.responseSize, text: prettyJSON(log.response) },
    ])

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

{#snippet copyButton(text: string, key: string)}
    <button
        class="p-1 rounded-md transition-colors hover:bg-selected {copiedKey === key ? 'text-green-500' : 'text-textcolor2 hover:text-textcolor'}"
        onclick={() => copy(text, key)}
        title={language.requestLogs.copy}
    >
        {#if copiedKey === key}<CheckIcon size={14} />{:else}<CopyIcon size={14} />{/if}
    </button>
{/snippet}

{#snippet code(text: string)}
    <pre class="request-log-code {wrap ? 'wrap' : ''} {$ColorSchemeTypeStore === 'light' ? 'light' : ''}">{@html highlight(text)}</pre>
{/snippet}

<div class="flex flex-col min-w-0 h-full">
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
            <Button size="sm" selected={showHeaders} onclick={() => showHeaders = !showHeaders}>{language.requestLogs.headers}</Button>

            <div class="flex-1"></div>

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
            {#snippet curlIcon()}
                {#if copiedKey === 'curl'}<CheckIcon size={16} class="text-green-500" />{:else}<TerminalIcon size={16} />{/if}
            {/snippet}
            {@render iconButton(() => copy(buildCurl(log, revealSecrets), 'curl'), language.requestLogs.copyCurl, false, curlIcon)}
            {#snippet downloadIcon()}<DownloadIcon size={16} />{/snippet}
            {@render iconButton(download, language.requestLogs.download, false, downloadIcon)}
        </div>
    </div>

    {#if showHeaders}
        <div class="border-t border-darkborderc px-4 py-3 max-h-48 overflow-auto shrink-0">
            <div class="flex items-center gap-2 mb-2 text-sm">
                <span class="font-semibold text-textcolor">{language.requestLogs.headers}</span>
                <span class="flex-1"></span>
                {@render copyButton(headerText, 'header')}
            </div>
            {@render code(headerText)}
        </div>
    {/if}

    <!-- Request / Response JSON, side by side on wide screens -->
    <div class="border-t border-darkborderc flex-1 min-h-0 flex flex-col md:grid md:grid-cols-2 overflow-auto md:overflow-hidden">
        {#each panes as pane, i (pane.key)}
            <section class="flex flex-col min-w-0 shrink-0 md:min-h-0 {i > 0 ? 'border-t md:border-t-0 md:border-l border-darkborderc' : ''}">
                <div class="flex items-center gap-2 px-4 pt-3 pb-2 text-sm shrink-0">
                    <span class="font-semibold text-textcolor">{pane.label}</span>
                    <span class="text-textcolor2">{formatBytes(pane.size)}</span>
                    <span class="flex-1"></span>
                    {@render copyButton(pane.text, pane.key)}
                </div>
                <div class="px-4 pb-4 md:flex-1 md:min-h-0 md:overflow-auto">
                    {@render code(pane.text)}
                </div>
            </section>
        {/each}
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
        overflow-wrap: anywhere;
    }
    .request-log-code :global(.hljs-attr) { color: var(--log-key); }
    .request-log-code :global(.hljs-string) { color: var(--log-string); }
    .request-log-code :global(.hljs-number) { color: var(--log-number); }
    .request-log-code :global(.hljs-literal) { color: var(--log-literal); }
    .request-log-code :global(.hljs-punctuation) { color: var(--risu-theme-textcolor2); }
</style>
