**Title:** fix(tauri): coalesce streamed_fetch chunks instead of draining one per tick

**Branch:** `fix/tauri-stream-coalesce` (1 commit on `main`)

---

## PR Checklist

- Required Checks
    - [ ] Have you added type definitions?
    - [ ] Have you tested your changes?
    - [ ] Have you checked that it won't break any existing features?
- [ ] If your PR uses models[^1], check the following:
    - [ ] Have you checked if it works normally in all models?
    - [ ] Have you checked if it works normally in all web, local, and node-hosted versions? If it doesn't, have you blocked it in those versions?
- [ ] If your PR is highly AI generated[^2], check the following:
    - [ ] Have you understood what the code does?
    - [ ] Have you cleaned up any unnecessary or redundant code?
    - [ ] Is it not a huge change?
       - We currently do not accept highly AI generated PRs that are large changes.


[^1]: Modifies the behavior of prompting, requesting, or handling responses from AI models.
[^2]: Over 80% of the code is AI generated.

## Summary

On the desktop (Tauri) build, streamed responses reach the chat one network chunk per 10 ms tick. When rendering a chunk takes longer than that (regex/CBS/Lua `editDisplay`, background HTML, long chats), the queue grows faster than it drains. The reply keeps "typing" long after the server has finished, and the UI stays busy the whole time.

With this change, each tick takes everything queued since the last tick and hands it over as one chunk. This is what the web build's `fetch()` stream already does.

## Related Issues

Closes #ISSUE_1

## Changes

`fetchNative()`, Tauri branch (`src/ts/globalApi.svelte.ts`), the `ReadableStream` loop:

- It takes all queued `streamed_fetch` events with `splice(0)` instead of `shift()`ing one.
- It concatenates their `chunk` bodies and enqueues them as one chunk, or the buffer itself when only one arrived.
- `headers` and `end` handling is unchanged.

Coalescing only removes chunk boundaries and never adds one. Every boundary a consumer sees after this change was already a boundary before it. The stream parsers already keep partial lines across reads, since network chunking is arbitrary, so SSE parsing is unaffected: the Anthropic reader keeps `parserData`, Google's transform keeps a running `buffer`, and the JSON-splitting transform in `request.ts` keeps its state across chunks.

## Impact

- Only the Tauri desktop build is affected. The web and node-hosted builds don't run this code.
- The bytes and their order are the same. The only difference is fewer, larger reads while the UI is busy.

Measured on the Linux desktop build (WebKitGTK) with a fake OpenAI-compatible server that streams 1,500 chunks at 300/s, so the server finishes in 5.0 s. Each value is the time from send until the last chunk is rendered:

| | before | after | web build |
|---|---|---|---|
| heavy bot | 126-132 s | 5.8-7.1 s | 5.9-7.5 s |
| simple bot | 71-76 s | 5.6-6.4 s | 5.6-6.4 s |

"Heavy bot" means a regex-generated HTML status card, a Lua `editDisplay` listener, background CSS and a 300-message chat.

The drain loop is shared by every desktop platform. The old cap (one network chunk per tick, so under 100 chunks/s even when rendering is free) therefore applies to Windows (WebView2) too. I ran the same test on a GitHub Actions `windows-latest` runner (WebView2 153). It compares desktop builds without and with this change, the v2026.8.250 release, and the web build in Edge on the same machine:

| | before | v2026.8.250 | after | web build (Edge) |
|---|---|---|---|---|
| heavy bot | 23.3-25.2 s | 22.8-25.7 s | 5.4-5.9 s | 5.3-5.7 s* |
| simple bot | 19.7-21.0 s | 19.7-21.9 s | 5.3-5.8 s | 5.3-5.6 s |

\* This cell comes from an earlier run on the same kind of runner, because the web heavy-bot test hit a harness error in this run.

On this branch, `pnpm check` (0 errors), `pnpm build` and `pnpm test` (239 passed) pass.

## Additional Notes

- Only an OpenAI-compatible SSE stream was tested end to end. The change sits below the provider layer: it only changes how many bytes each read of the response body returns.
- Most of this change, and the measurements above, were produced with an AI assistant (Claude Code). The Windows measurements come from a benchmark workflow in my fork: https://github.com/SameDesu123/Risuai/actions/runs/37259263507

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012gh4XeiASSGgQZowZWFKHT
