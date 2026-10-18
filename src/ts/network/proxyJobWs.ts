import { v4 as uuidv4 } from 'uuid';

export type ProxyJobWsEvent = (
    | { type: 'job_accepted', jobId: string }
    | { type: 'upstream_headers', status: number, headers: Record<string, string> }
    | { type: 'chunk', dataBase64: string }
    | { type: 'error', status?: number, message: string }
    | { type: 'done' }
    | { type: 'ping', ts: number }
) & {
    // Set on every event the server keeps for replay; `job_accepted` and `ping` carry none
    seq?: number
};

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
    if (status === 504 || status === 524 || text.includes('Cloudflare') || text.includes('Gateway time-out') || text.includes('A timeout occurred')) {
        return `Cloudflare/origin timeout (${status ?? 'unknown'}). The origin server did not start sending response in time.`;
    }
    return text || `Proxy stream failed (${status ?? 'unknown'})`;
}

export interface ProxyJobStreamRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyBase64: string;
    timeoutMs?: number;
    heartbeatSec: number;
}

export interface ProxyJobStreamOptions {
    // Origin of the HTTP job routes, '' for the page's own
    baseUrl: string;
    // Origin of the WebSocket route, such as `wss://example.com`
    wsBaseUrl: string;
    auth: string;
    request: ProxyJobStreamRequest;
    signal?: AbortSignal;
    // `signal` may stop firing once the response starts (its request timeout gets cleaned up), so the
    // caller's own signal is passed separately to cancel the job for as long as the stream runs
    streamSignal?: AbortSignal;
}

export interface ProxyJobStreamResponse {
    status: number;
    headers: Record<string, string>;
    body: ReadableStream<Uint8Array>;
}

export interface ProxyJobSocket {
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: unknown) => void) | null;
    onerror: ((event: unknown) => void) | null;
    close(): void;
}

export interface ProxyJobStreamDeps {
    fetch: (url: string, init?: RequestInit) => Promise<Response>;
    createWebSocket: (url: string) => ProxyJobSocket;
    createJobId: () => string;
    // Calls back when the page may be running again after a suspension; returns an unsubscribe function
    onWake: (callback: () => void) => () => void;
}

/**
 * Thrown when creating a job failed in a way that leaves open whether the server got the request,
 * so the caller must not send it again over another route that could run it a second time
 */
export class ProxyJobCreateUncertainError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ProxyJobCreateUncertainError';
    }
}

const createRetryDelaysMs = [1000, 2000, 4000];
const reconnectDelaysMs = [500, 1000, 2000, 4000, 8000, 15000];
const connectionLostMessage = 'Proxy WebSocket connection lost before the response finished';
const jobGoneMessage = 'Proxy stream job no longer exists on the server (it expired, was cancelled, or the server restarted)';

function subscribeToPageWake(callback: () => void) {
    if (typeof document === 'undefined') {
        return () => {};
    }
    const onVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            callback();
        }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('online', callback);
    return () => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('online', callback);
    };
}

const defaultProxyJobStreamDeps: ProxyJobStreamDeps = {
    fetch: (url, init) => fetch(url, init),
    createWebSocket: (url) => new WebSocket(url),
    // crypto.randomUUID only exists in secure contexts, which a LAN server over plain HTTP is not
    createJobId: () => uuidv4(),
    onWake: subscribeToPageWake
};

function waitOrAbort(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// Gateways answer these whether or not the request reached the server behind them
function isGatewayFailure(status: number) {
    return status === 502 || status === 503 || status === 504 || status === 524;
}

async function createProxyJob(
    options: ProxyJobStreamOptions,
    fetchFn: ProxyJobStreamDeps['fetch'],
    jobId: string,
    deleteJob: () => void
): Promise<{ heartbeatSec?: number }> {
    // The server treats a repeated job ID with the same request as the same job, so retrying cannot
    // start the request twice
    const body = JSON.stringify({ jobId, ...options.request });
    for (let attempt = 0; ; attempt++) {
        let failure: unknown = null;
        let res: Response | null = null;
        try {
            res = await fetchFn(`${options.baseUrl}/proxy-stream-jobs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'risu-auth': options.auth
                },
                body,
                signal: options.signal
            });
        } catch (error) {
            failure = error;
        }
        if (options.signal?.aborted) {
            // The job may have been created before the abort
            deleteJob();
            throw options.signal.reason;
        }
        if (res?.ok) {
            try {
                return await res.json();
            } catch (error) {
                failure = error;
            }
        }
        else if (res) {
            const text = await res.text().catch(() => '');
            if (!isGatewayFailure(res.status)) {
                throw new Error(`Proxy stream job creation failed: ${res.status} ${text}`);
            }
            failure = `${res.status} ${text}`;
        }
        if (attempt >= createRetryDelaysMs.length) {
            deleteJob();
            throw new ProxyJobCreateUncertainError(`Proxy stream job creation failed: ${failure}`);
        }
        try {
            await waitOrAbort(createRetryDelaysMs[attempt], options.signal);
        } catch (error) {
            deleteJob();
            throw error;
        }
    }
}

/**
 * Starts a proxy stream job and exposes its output as a response body.
 *
 * The job runs on the server whether or not this page stays connected, so when the WebSocket drops
 * (a backgrounded Safari tab gets suspended, the network blips) this reconnects and replays what it
 * missed after the last seq it saw. The body errors only once the job is gone or the server stays
 * unreachable, and never ends early as if the response were complete.
 */
export async function openProxyJobStream(
    options: ProxyJobStreamOptions,
    deps: Partial<ProxyJobStreamDeps> = {}
): Promise<ProxyJobStreamResponse> {
    const { fetch: fetchFn, createWebSocket, createJobId, onWake } = { ...defaultProxyJobStreamDeps, ...deps };
    const jobId = createJobId();
    const jobUrl = `${options.baseUrl}/proxy-stream-jobs/${encodeURIComponent(jobId)}`;
    const authHeaders = { 'risu-auth': options.auth };
    // Stops a job nobody will read, or frees the copy of a finished one kept for reconnecting
    const deleteJob = () => {
        void fetchFn(jobUrl, { method: 'DELETE', headers: authHeaders }).catch(() => {});
    };

    const created = await createProxyJob(options, fetchFn, jobId, deleteJob);
    const heartbeatMs = (created.heartbeatSec ?? options.request.heartbeatSec) * 1000;

    let status = 200;
    let responseHeaders: Record<string, string> = { 'content-type': 'text/event-stream' };
    let headersReady = false;
    let settled = false;
    let lastSeq = 0;
    let failures = 0;
    let lastActivityAt = 0;
    // Bumped whenever the connection is replaced, so work started for an older one stops
    let generation = 0;
    let socket: ProxyJobSocket | null = null;
    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopWake = () => {};
    let resolveHeaders: () => void = () => {};
    const waitHeaders = new Promise<void>((resolve) => {
        resolveHeaders = resolve;
    });
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const abortSignals = [...new Set([options.signal, options.streamSignal])].filter((signal): signal is AbortSignal => !!signal);

    const body = new ReadableStream<Uint8Array>({
        start(streamController) {
            controller = streamController;
        },
        cancel() {
            if (settled) {
                return;
            }
            // Nothing can pick the job up once its reader is gone
            deleteJob();
            settle();
        }
    });

    const ensureHeadersReady = () => {
        if (!headersReady) {
            headersReady = true;
            resolveHeaders();
        }
    };

    const dropSocket = () => {
        generation++;
        clearTimeout(watchdogTimer);
        clearTimeout(reconnectTimer);
        if (!socket) {
            return;
        }
        const closing = socket;
        socket = null;
        closing.onmessage = null;
        closing.onclose = null;
        closing.onerror = null;
        try {
            closing.close();
        } catch {
            // no-op
        }
    };

    const settle = () => {
        settled = true;
        dropSocket();
        stopWake();
        for (const signal of abortSignals) {
            signal.removeEventListener('abort', abortHandler);
        }
    };

    const endStream = () => {
        if (settled) {
            return;
        }
        ensureHeadersReady();
        settle();
        controller.close();
    };

    // Once the response has started the caller reads only the body, so a failure has to error the
    // stream: closing it would pass a cut-off response off as a complete one
    const failStream = (failStatus: number, message: string) => {
        if (settled) {
            return;
        }
        if (headersReady) {
            settle();
            controller.error(new Error(message));
            return;
        }
        status = failStatus;
        responseHeaders = { 'content-type': 'text/plain; charset=utf-8' };
        controller.enqueue(encoder.encode(message));
        endStream();
    };

    const abandon = (message: string) => {
        deleteJob();
        failStream(502, message);
    };

    const handleEvent = (event: ProxyJobWsEvent) => {
        if (settled) {
            return;
        }
        if (typeof event.seq === 'number') {
            // A reconnect replays from the last seq seen, which can overlap what already arrived
            if (event.seq <= lastSeq) {
                return;
            }
            if (event.seq !== lastSeq + 1) {
                abandon(`Proxy stream skipped events ${lastSeq + 1}-${event.seq - 1}`);
                return;
            }
            lastSeq = event.seq;
        }
        switch (event.type) {
            case 'job_accepted':
            case 'ping':
                return;
            case 'upstream_headers':
                status = event.status;
                responseHeaders = event.headers ?? {};
                ensureHeadersReady();
                return;
            case 'chunk':
                ensureHeadersReady();
                controller.enqueue(decodeProxyJobWsChunk(event.dataBase64));
                return;
            case 'error':
                deleteJob();
                // The formatted message explains a response that never started, which is wrong mid-stream
                failStream(event.status ?? 502, headersReady
                    ? `Proxy stream failed (${event.status ?? 'unknown'}): ${event.message}`
                    : formatProxyStreamErrorMessage(event.status, event.message));
                return;
            case 'done':
                deleteJob();
                endStream();
                return;
        }
    };

    const reconnect = () => {
        if (settled) {
            return;
        }
        dropSocket();
        if (failures >= reconnectDelaysMs.length) {
            abandon(connectionLostMessage);
            return;
        }
        reconnectTimer = setTimeout(() => void resume(), reconnectDelaysMs[failures]);
        failures++;
    };

    // A socket can look open long after the network under it is gone, which only missed pings reveal
    const armWatchdog = () => {
        clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(reconnect, heartbeatMs * 3);
    };

    const connect = () => {
        dropSocket();
        lastActivityAt = Date.now();
        socket = createWebSocket(`${options.wsBaseUrl}/proxy-stream-jobs/${encodeURIComponent(jobId)}/ws?risu-auth=${encodeURIComponent(options.auth)}&since=${lastSeq}`);
        armWatchdog();
        socket.onmessage = (message) => {
            const event = parseProxyJobWsEvent(typeof message.data === 'string' ? message.data : '');
            if (!event) {
                return;
            }
            failures = 0;
            lastActivityAt = Date.now();
            armWatchdog();
            handleEvent(event);
        };
        // Only `done` or `error` ends a job, so a close before either means the connection dropped
        socket.onclose = reconnect;
        socket.onerror = reconnect;
    };

    // Catches up over HTTP before reopening the socket: unlike a failed WebSocket handshake, it tells
    // a job that is gone (404) apart from a server that is unreachable, and it finishes a job that
    // ended in the meantime without needing a socket at all
    const resume = async () => {
        const current = generation;
        let snapshot: { events?: ProxyJobWsEvent[] } | null = null;
        let gone = false;
        // A request on a dead connection can hang instead of failing
        const request = new AbortController();
        const requestTimer = setTimeout(() => request.abort(), heartbeatMs * 3);
        try {
            const res = await fetchFn(`${jobUrl}?since=${lastSeq}`, { headers: authHeaders, signal: request.signal });
            gone = res.status === 404;
            snapshot = res.ok ? await res.json() : null;
        } catch {
            // Still unreachable
        }
        clearTimeout(requestTimer);
        if (settled || current !== generation) {
            return;
        }
        if (gone) {
            failStream(502, jobGoneMessage);
            return;
        }
        if (!snapshot) {
            reconnect();
            return;
        }
        const seqBefore = lastSeq;
        for (const event of snapshot.events ?? []) {
            handleEvent(event);
        }
        if (settled) {
            return;
        }
        // The server is answering and the job is moving, so only the socket is having trouble
        if (lastSeq > seqBefore) {
            failures = 0;
        }
        connect();
    };

    function abortHandler() {
        if (settled) {
            return;
        }
        // Without this the server keeps generating after the user stops
        deleteJob();
        if (!headersReady) {
            status = 499;
            responseHeaders = { 'content-type': 'text/plain; charset=utf-8' };
            controller.enqueue(encoder.encode('Aborted'));
        }
        endStream();
    }

    for (const signal of abortSignals) {
        if (signal.aborted) {
            abortHandler();
            break;
        }
        signal.addEventListener('abort', abortHandler, { once: true });
    }
    if (!settled) {
        stopWake = onWake(() => {
            if (settled) {
                return;
            }
            // A socket that went quiet across a suspension can still look open; a fresh one is cheap
            // because the server replays from the last seq seen
            if (socket && Date.now() - lastActivityAt < heartbeatMs + 5000) {
                return;
            }
            failures = 0;
            dropSocket();
            void resume();
        });
        connect();
    }

    await waitHeaders;
    return {
        status,
        headers: responseHeaders,
        body
    };
}
