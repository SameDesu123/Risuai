export type ProxyJobWsEvent = (
    | { type: 'job_accepted', jobId: string, resumable?: boolean }
    | { type: 'upstream_headers', status: number, headers: Record<string, string> }
    | { type: 'chunk', dataBase64: string }
    | { type: 'error', status?: number, message: string, code?: string }
    | { type: 'done' }
    | { type: 'ping', ts: number }
) & { seq?: number };

export function parseProxyJobWsEvent(raw: string): ProxyJobWsEvent | null {
    try {
        const parsed = JSON.parse(raw) as ProxyJobWsEvent;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function decodeProxyJobWsChunk(dataBase64: string): Uint8Array {
    return Buffer.from(dataBase64, 'base64');
}

export function formatProxyStreamErrorMessage(status: number | undefined, message: string): string {
    const text = message ?? '';
    // Only rewrite gateway pages; the relay's own 504 messages (e.g. idle timeout) say more as they are.
    const looksLikeGatewayPage = !text.trim() || text.trimStart().startsWith('<');
    if (((status === 504 || status === 524) && looksLikeGatewayPage) || text.includes('Cloudflare') || text.includes('Gateway time-out') || text.includes('A timeout occurred')) {
        return `Cloudflare/origin timeout (${status ?? 'unknown'}). The origin server did not start sending response in time.`;
    }
    return text || `Proxy stream failed (${status ?? 'unknown'})`;
}

/** The part of the browser WebSocket the relay uses, so tests can pass a fake. */
export interface ProxyJobWsSocket {
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onclose: ((event: unknown) => void) | null;
    close(): void;
}

export type ProxyJobWsSocketFactory = new (url: string) => ProxyJobWsSocket;

export interface ProxyJobWsRelayDeps {
    fetch: typeof fetch;
    WebSocket: ProxyJobWsSocketFactory;
}

export interface ProxyJobWsReconnectOptions {
    initialDelayMs: number;
    maxDelayMs: number;
    /** Give up when the socket stays unusable for this long. */
    budgetMs: number;
}

export interface ProxyJobWsRelayOptions {
    /** HTTP base for the job API; '' for same origin. */
    baseUrl: string;
    /** WebSocket origin such as `wss://host`. */
    wsOrigin: string;
    auth: string;
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: Uint8Array;
    signal?: AbortSignal;
    /** Sent to the server, which aborts the upstream after this long without data. */
    requestTimeoutMs?: number;
    heartbeatSec: number;
    reconnect?: Partial<ProxyJobWsReconnectOptions>;
}

export interface ProxyJobWsRelayResult {
    status: number;
    headers: Record<string, string>;
    body: ReadableStream<Uint8Array>;
}

const defaultReconnect: ProxyJobWsReconnectOptions = {
    initialDelayMs: 500,
    maxDelayMs: 4000,
    budgetMs: 30000
};

const plainTextHeaders = () => ({ 'content-type': 'text/plain; charset=utf-8' });

function makeAbortError() {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
}

/**
 * Runs one streaming request through the Node server's Job + WebSocket relay.
 *
 * Every relayed event carries a `seq`. When the socket drops before `done`/`error`,
 * the relay reconnects with `after=<last seq>` and continues where it left off.
 * Failures after the headers end the body with an error, never with a clean close,
 * so a cut-off reply is not saved as if it were complete.
 *
 * Throws only when the job cannot be created, so the caller can fall back to /proxy2.
 */
export async function startProxyJobWsRelay(
    opts: ProxyJobWsRelayOptions,
    deps: ProxyJobWsRelayDeps
): Promise<ProxyJobWsRelayResult> {
    const reconnect = { ...defaultReconnect, ...(opts.reconnect ?? {}) };
    const requestSignal = opts.signal;
    const baseUrl = opts.baseUrl;

    const createRes = await deps.fetch(`${baseUrl}/proxy-stream-jobs`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'risu-auth': opts.auth
        },
        body: JSON.stringify({
            url: opts.url,
            method: opts.method,
            headers: opts.headers ?? {},
            bodyBase64: opts.body ? Buffer.from(opts.body).toString('base64') : '',
            timeoutMs: opts.requestTimeoutMs,
            heartbeatSec: opts.heartbeatSec
        }),
        signal: requestSignal
    });

    if (!createRes.ok) {
        const errText = await createRes.text();
        throw new Error(`Proxy stream job creation failed: ${createRes.status} ${errText}`);
    }

    const created = await createRes.json() as { jobId?: string, heartbeatSec?: number };
    if (!created.jobId) {
        throw new Error('Proxy stream job creation returned no jobId');
    }
    const jobId = created.jobId;
    const heartbeatSec = Number(created.heartbeatSec) > 0 ? Number(created.heartbeatSec) : opts.heartbeatSec;
    const watchdogMs = Math.max(1, heartbeatSec) * 3 * 1000;
    const wsBaseUrl = `${opts.wsOrigin}/proxy-stream-jobs/${encodeURIComponent(jobId)}/ws?risu-auth=${encodeURIComponent(opts.auth)}`;

    let status = 200;
    let responseHeaders: Record<string, string> = { 'content-type': 'text/event-stream' };
    let headersReady = false;
    let resolveHeaders: () => void = () => {};
    const waitHeaders = new Promise<void>((resolve) => {
        resolveHeaders = resolve;
    });
    const ensureHeadersReady = () => {
        if (!headersReady) {
            headersReady = true;
            resolveHeaders();
        }
    };

    let settled = false;
    let released = false;
    let lastSeq = 0;
    /** null until the server tells us; false for servers that predate seq numbers. */
    let resumable: boolean | null = null;
    let socket: ProxyJobWsSocket | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disconnectedSince: number | null = null;
    let reconnectDelay = reconnect.initialDelayMs;
    let streamController!: ReadableStreamDefaultController<Uint8Array>;

    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
        },
        cancel() {
            finish({ kind: 'cancelled' });
        }
    });

    const releaseJob = () => {
        if (released) {
            return;
        }
        released = true;
        void deps.fetch(`${baseUrl}/proxy-stream-jobs/${encodeURIComponent(jobId)}`, {
            method: 'DELETE',
            headers: {
                'risu-auth': opts.auth
            },
            keepalive: true
        }).catch(() => {});
    };

    const clearWatchdog = () => {
        if (watchdog !== null) {
            clearTimeout(watchdog);
            watchdog = null;
        }
    };

    const dropSocket = () => {
        clearWatchdog();
        const current = socket;
        socket = null;
        if (!current) {
            return;
        }
        current.onopen = null;
        current.onmessage = null;
        current.onerror = null;
        current.onclose = null;
        try {
            current.close();
        } catch {
            // no-op
        }
    };

    type Outcome =
        | { kind: 'done' }
        | { kind: 'cancelled' }
        | { kind: 'aborted' }
        | { kind: 'failed', status: number, message: string };

    function finish(outcome: Outcome) {
        if (settled) {
            return;
        }
        settled = true;
        if (reconnectTimer !== null) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        dropSocket();
        requestSignal?.removeEventListener('abort', onAbort);
        // Done jobs are freed right away instead of waiting for the server's grace period.
        releaseJob();

        if (outcome.kind === 'cancelled') {
            return;
        }
        if (outcome.kind === 'done') {
            ensureHeadersReady();
            try {
                streamController.close();
            } catch {
                // no-op
            }
            return;
        }
        if (!headersReady) {
            // Nothing was handed out yet: answer with an error response the caller can show.
            status = outcome.kind === 'aborted' ? 499 : outcome.status;
            responseHeaders = plainTextHeaders();
            const text = outcome.kind === 'aborted' ? 'Aborted' : outcome.message;
            ensureHeadersReady();
            try {
                streamController.enqueue(new TextEncoder().encode(text));
                streamController.close();
            } catch {
                // no-op
            }
            return;
        }
        try {
            streamController.error(outcome.kind === 'aborted' ? makeAbortError() : new Error(outcome.message));
        } catch {
            // no-op
        }
    }

    function onAbort() {
        finish({ kind: 'aborted' });
    }

    const armWatchdog = () => {
        clearWatchdog();
        watchdog = setTimeout(() => {
            watchdog = null;
            handleDisconnect();
        }, watchdogMs);
    };

    const handleEvent = (parsed: ProxyJobWsEvent) => {
        if (parsed.type === 'job_accepted') {
            if (parsed.resumable) {
                resumable = true;
            }
            return;
        }
        if (parsed.type === 'ping') {
            return;
        }
        if (typeof parsed.seq === 'number') {
            resumable = true;
            if (parsed.seq <= lastSeq) {
                // Already delivered before the reconnect.
                return;
            }
            lastSeq = parsed.seq;
        }
        else if (parsed.type !== 'error' || parsed.code !== 'replay_gap') {
            resumable = false;
        }

        switch (parsed.type) {
            case 'upstream_headers':
                status = parsed.status;
                responseHeaders = parsed.headers ?? {};
                ensureHeadersReady();
                return;
            case 'chunk':
                ensureHeadersReady();
                streamController.enqueue(decodeProxyJobWsChunk(parsed.dataBase64));
                return;
            case 'error':
                finish({
                    kind: 'failed',
                    status: parsed.status ?? 502,
                    message: formatProxyStreamErrorMessage(parsed.status, parsed.message)
                });
                return;
            case 'done':
                finish({ kind: 'done' });
                return;
        }
    };

    function connect() {
        if (settled) {
            return;
        }
        const ws = new deps.WebSocket(`${wsBaseUrl}&after=${lastSeq}`);
        socket = ws;
        armWatchdog();
        ws.onmessage = (event) => {
            if (socket !== ws || settled) {
                return;
            }
            armWatchdog();
            const parsed = parseProxyJobWsEvent(typeof event.data === 'string' ? event.data : '');
            if (!parsed) {
                return;
            }
            // Any message proves the link works again.
            disconnectedSince = null;
            reconnectDelay = reconnect.initialDelayMs;
            handleEvent(parsed);
        };
        ws.onerror = () => {
            if (socket === ws) {
                handleDisconnect();
            }
        };
        ws.onclose = () => {
            if (socket === ws) {
                handleDisconnect();
            }
        };
    }

    function handleDisconnect() {
        if (settled) {
            return;
        }
        dropSocket();
        if (resumable === false) {
            finish({ kind: 'failed', status: 502, message: 'Proxy stream connection lost (server does not support resuming)' });
            return;
        }
        const now = Date.now();
        disconnectedSince ??= now;
        if (now - disconnectedSince >= reconnect.budgetMs) {
            finish({ kind: 'failed', status: 502, message: 'Proxy stream connection lost and could not be resumed' });
            return;
        }
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnect.maxDelayMs, reconnectDelay * 2);
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
        }, delay);
    }

    if (requestSignal?.aborted) {
        finish({ kind: 'aborted' });
    }
    else {
        // Stays attached until the stream ends, so a stop after the headers still reaches the upstream.
        requestSignal?.addEventListener('abort', onAbort, { once: true });
        connect();
    }

    await waitHeaders;
    return {
        status,
        headers: responseHeaders,
        body
    };
}
