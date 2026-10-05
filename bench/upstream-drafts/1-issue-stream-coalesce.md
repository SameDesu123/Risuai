**Title:** Desktop (Tauri): streamed replies keep "typing" long after the server has finished

---

### What happens

On the desktop (Tauri) build, a streamed reply is drawn much more slowly than the server sends it. A reply that the server finishes in 5 seconds keeps "typing" for about 20-25 seconds on Windows, and for one to two minutes on Linux. The window stays sluggish the whole time. The web build on the same machine keeps up with the server.

It is worst with bots that do a lot of work per render (regex-generated HTML, a Lua `editDisplay` listener, background CSS), but even a plain bot is about 4 times slower than the web build on Windows, and more than 10 times slower on Linux.

### Measurements

A fake OpenAI-compatible server streams 1,500 chunks at 300 chunks/s, so it finishes in 5.0 s. Each value is the time from pressing send until the last chunk is rendered.

| | desktop, current `main` | desktop, v2026.8.250 | web build, same machine |
|---|---|---|---|
| Windows (WebView2 153), heavy bot | 23.3-25.2 s | 22.8-25.7 s | 5.3-5.7 s* |
| Windows, simple bot | 19.7-21.0 s | 19.7-21.9 s | 5.3-5.6 s |
| Linux (WebKitGTK), heavy bot | 126-132 s | 120-137 s | 5.9-7.5 s |
| Linux, simple bot | 71-76 s | not measured | 5.6-6.4 s |

"Heavy bot" means a regex-generated HTML status card, a Lua `editDisplay` listener, background CSS and a 300-message chat.

\* This cell comes from an earlier run on the same kind of runner, because the web heavy-bot test hit a harness error in the main run.

### Cause

The Tauri branch of `fetchNative()` (`src/ts/globalApi.svelte.ts`) feeds the response stream like this:

```ts
while (!resolved || nativeFetchData[fetchId].length > 0) {
    if (nativeFetchData[fetchId].length > 0) {
        const data = nativeFetchData[fetchId].shift()
        // ... enqueue this one network chunk
    }
    await sleep(10)
}
```

It hands over exactly one queued `streamed_fetch` event per 10 ms tick. This has two effects:

- The reply can never arrive faster than one network chunk per tick, so it is capped below 100 chunks/s even when rendering costs nothing.
- Every network chunk goes through the whole per-chunk pipeline on its own: SSE parsing, the message update, regex/CBS/Lua `editDisplay`, sanitizing and save change detection.

Once rendering a chunk takes longer than one tick, the queue grows faster than it drains. In the web build, the browser's `fetch()` stream returns everything that has arrived as one read, so it catches up by itself.

### Suggested fix

Each tick, drain everything queued since the last tick and enqueue it as one chunk. The bytes and their order stay the same. Stream consumers already buffer partial lines, since network chunk boundaries are arbitrary anyway. I have a PR ready.

### Environment

- Current `main` and release v2026.8.250
- Windows: GitHub Actions `windows-latest` runner (4 vCPU, 16 GB), WebView2 153.0.4234.48
- Linux: WebKitGTK desktop build

_I found and measured this with the help of an AI assistant (Claude Code)._
