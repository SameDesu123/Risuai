const crypto = require('crypto');

const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidProxyStreamJobId(jobId) {
    return typeof jobId === 'string' && JOB_ID_PATTERN.test(jobId);
}

function normalizeSinceSeq(raw) {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * In-memory registry for proxy stream jobs.
 *
 * Every event a job produces is kept with a sequence number until the job is
 * deleted or its result expires, so a client whose connection dropped (for
 * example a backgrounded Safari tab) can reconnect and replay what it missed.
 * A client closing its connection never deletes a job, because the server
 * cannot tell whether it received everything first.
 */
function createProxyStreamJobStore(options) {
    const now = options.now ?? Date.now;
    const jobs = new Map();
    let totalLogBytes = 0;

    function get(jobId) {
        return jobs.get(jobId);
    }

    function countRunning() {
        let count = 0;
        for (const job of jobs.values()) {
            if (!job.done) {
                count++;
            }
        }
        return count;
    }

    function create(arg) {
        const createdAt = now();
        const job = {
            id: arg.jobId ?? crypto.randomUUID(),
            requestHash: arg.requestHash ?? '',
            createdAt,
            updatedAt: createdAt,
            done: false,
            doneAt: 0,
            clients: new Set(),
            events: [],
            logBytes: 0,
            abortController: new AbortController(),
            deadlineAt: createdAt + arg.timeoutMs,
            staleAfterMs: arg.staleAfterMs,
            heartbeatSec: arg.heartbeatSec,
            timeoutMs: arg.timeoutMs
        };
        jobs.set(job.id, job);
        return job;
    }

    function remove(jobId) {
        const job = jobs.get(jobId);
        if (!job) {
            return;
        }
        jobs.delete(jobId);
        totalLogBytes -= job.logBytes;
        // Stops a still-running upstream from appending to a deleted job
        job.done = true;
        job.abortController.abort();
        for (const client of job.clients) {
            try {
                client.close();
            } catch {
                // ignore
            }
        }
        job.clients.clear();
    }

    function evictOldestDoneJob(except) {
        let oldest = null;
        for (const job of jobs.values()) {
            if (job.done && job !== except && (!oldest || job.doneAt < oldest.doneAt)) {
                oldest = job;
            }
        }
        if (!oldest) {
            return false;
        }
        remove(oldest.id);
        return true;
    }

    function hasRoomFor(job, size) {
        if (job.logBytes + size > options.maxJobLogBytes) {
            return false;
        }
        // Unclaimed results give way to jobs that are still streaming
        while (totalLogBytes + size > options.maxTotalLogBytes) {
            if (!evictOldestDoneJob(job)) {
                return false;
            }
        }
        return true;
    }

    function finish(job) {
        job.done = true;
        job.doneAt = now();
        let doneCount = 0;
        for (const other of jobs.values()) {
            if (other.done) {
                doneCount++;
            }
        }
        while (doneCount > options.maxRetainedJobs && evictOldestDoneJob(job)) {
            doneCount--;
        }
    }

    /**
     * Appends an event, sends it to attached clients, and finishes the job on
     * `done` or `error`. Returns false once the job no longer accepts events.
     */
    function push(job, event) {
        if (job.done) {
            return false;
        }
        const text = JSON.stringify({ ...event, seq: job.events.length + 1 });
        const size = Buffer.byteLength(text);
        if (event.type === 'chunk' && !hasRoomFor(job, size)) {
            // Fail loudly rather than hand the client a response with a gap in it
            push(job, {
                type: 'error',
                status: 507,
                message: 'Response exceeded the proxy stream buffer limit'
            });
            job.abortController.abort();
            return false;
        }
        job.events.push(text);
        job.logBytes += size;
        totalLogBytes += size;
        job.updatedAt = now();
        for (const client of job.clients) {
            if (client.readyState === client.OPEN) {
                client.send(text);
            }
        }
        if (event.type === 'done' || event.type === 'error') {
            finish(job);
        }
        return true;
    }

    function eventsSince(job, since) {
        return job.events.slice(since);
    }

    function attach(job, client, since) {
        for (const text of eventsSince(job, since)) {
            client.send(text);
        }
        job.clients.add(client);
    }

    function detach(job, client) {
        job.clients.delete(client);
    }

    function snapshot(job, since) {
        return `{"jobId":${JSON.stringify(job.id)},"done":${job.done},"lastSeq":${job.events.length},"events":[${eventsSince(job, since).join(',')}]}`;
    }

    function collectGarbage() {
        const current = now();
        for (const job of [...jobs.values()]) {
            if (job.done) {
                if (current - job.doneAt >= options.resultTtlMs) {
                    remove(job.id);
                }
                continue;
            }
            if (current >= job.deadlineAt) {
                job.abortController.abort();
            }
            if (current - job.updatedAt > job.staleAfterMs) {
                remove(job.id);
            }
        }
    }

    return {
        get,
        countRunning,
        create,
        remove,
        push,
        attach,
        detach,
        eventsSince,
        snapshot,
        collectGarbage,
        get totalLogBytes() {
            return totalLogBytes;
        }
    };
}

module.exports = {
    createProxyStreamJobStore,
    isValidProxyStreamJobId,
    normalizeSinceSeq
};
