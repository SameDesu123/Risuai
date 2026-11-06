import { describe, expect, it } from "vitest";

import { getSmoothStreamingConflicts, isSmoothStreamingActive, smoothStream } from "../smoothStream";
import type { Database } from "../../storage/database.svelte";

type Chunk = Record<string, string>;

function sourceFrom(chunks: Chunk[]) {
    return new ReadableStream<Chunk>({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        },
    });
}

async function collect(stream: ReadableStream<Chunk>) {
    const out: Chunk[] = [];
    const reader = stream.getReader();
    while (true) {
        const r = await reader.read();
        if (r.value) out.push(r.value);
        if (r.done) break;
    }
    return out;
}

describe("smoothStream", () => {
    it("reveals text gradually and ends with the full chunk", async () => {
        const text = "a".repeat(200);
        const out = await collect(smoothStream(sourceFrom([{ "0": text, "1": "reroll" }])));

        expect(out.length).toBeGreaterThan(2);
        const lengths = out.map((c) => c["0"].length);
        for (let i = 1; i < lengths.length; i++) {
            expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
        }
        expect(out.at(-1)).toEqual({ "0": text, "1": "reroll" });
    });

    it("does not split surrogate pairs", async () => {
        const text = "😀".repeat(50);
        const out = await collect(smoothStream(sourceFrom([{ "0": text }])));
        for (const c of out) {
            const last = c["0"].charCodeAt(c["0"].length - 1);
            expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        }
    });

    it("emits nothing for an empty source", async () => {
        expect(await collect(smoothStream(sourceFrom([])))).toEqual([]);
    });

    it("propagates source errors", async () => {
        const source = new ReadableStream<Chunk>({
            start(controller) {
                controller.error(new Error("boom"));
            },
        });
        await expect(collect(smoothStream(source))).rejects.toThrow("boom");
    });

    it("cancels the source when cancelled", async () => {
        let cancelled = false;
        const source = new ReadableStream<Chunk>({
            start(controller) {
                controller.enqueue({ "0": "hello" });
            },
            cancel() {
                cancelled = true;
            },
        });
        const reader = smoothStream(source).getReader();
        await reader.read();
        await reader.cancel();
        expect(cancelled).toBe(true);
    });
});

describe("getSmoothStreamingConflicts", () => {
    const db = (patch: Partial<Database>) => ({ useStreaming: true, streamingDisplayOptimizationMode: "off", smoothStreaming: true, ...patch }) as Database;

    it("has no conflicts with streaming on and optimization off", () => {
        expect(getSmoothStreamingConflicts(db({}))).toEqual([]);
        expect(isSmoothStreamingActive(db({}))).toBe(true);
    });

    it("reports streaming off and display optimization on", () => {
        expect(getSmoothStreamingConflicts(db({ useStreaming: false, streamingDisplayOptimizationMode: "balanced" }))).toEqual([
            "responseStreamingOff",
            "streamingDisplayOptimizationOn",
        ]);
        expect(isSmoothStreamingActive(db({ streamingDisplayOptimizationMode: "strong" }))).toBe(false);
    });

    it("is inactive when the toggle is off", () => {
        expect(isSmoothStreamingActive(db({ smoothStreaming: false }))).toBe(false);
    });
});
