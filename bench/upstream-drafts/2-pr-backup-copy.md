**Title:** perf(tauri): copy the save backup on the Rust side instead of sending it over IPC again

**Branch:** `perf/tauri-backup-copy` (1 commit on `main`)

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

On desktop, `saveDb()` sends the whole encoded save over IPC twice per save: once for `database.bin` and once more for the new `dbbackup-*.bin`. IPC request bodies are expensive on Windows, so the second transfer doubles the time, the memory churn and the UI-thread stall of every save, for bytes that are already on disk. This PR writes `database.bin` once and lets plugin-fs copy it to the backup.

## Related Issues

Closes #ISSUE_2

## Changes

`saveDb()`, Tauri branch (`src/ts/globalApi.svelte.ts`): the second `writeFile(dbbackup-..., dbData)` is replaced with

```ts
await copyFile('database/database.bin', `database/dbbackup-${(Date.now() / 100).toFixed()}.bin`, {
    fromPathBaseDir: BaseDirectory.AppData,
    toPathBaseDir: BaseDirectory.AppData
});
```

`fs:allow-copy-file` and the `$APPDATA/**/*` scope are already granted in `src-tauri/capabilities/migrated.json`, so no capability change is needed.

## Impact

- Only the Tauri desktop build is affected. The web and node-hosted branches are unchanged.
- The backup is a byte-for-byte copy of the `database.bin` that was just written. Backup naming, the `getDbBackups()` pruning (20 newest) and the load-time fallback are unchanged.
- On Linux, `std::fs::copy` uses `copy_file_range`, so the data never passes through userspace. strace before: two 41 MB `write()`s that both came through IPC. After: one IPC `write()` and one in-kernel `copy_file_range` of the same 41 MB.

Measured on a GitHub Actions `windows-latest` runner (4 vCPU, 16 GB) with WebView2 153. A Lua button that changes chat variables is clicked 8 times on a save of the given size, and each click causes a save.

| save size | | median save time | host UI thread: longest stall / total stalled | peak private memory (whole app) |
|---|---|---|---|---|
| 16 MB | before | 773 ms | 77 ms / 0.77 s | 1017 MB |
| | after | 417 ms | 117 ms / 0.41 s | 853 MB |
| 40 MB | before | 2010 ms | 126 ms / 1.10 s | 1451 MB |
| | after | 1040 ms | 129 ms / 0.77 s | 1496 MB |
| 64 MB | before | 2630 ms | 160 ms / 1.13 s | 1952 MB |
| | after | 1368 ms | 156 ms / 0.83 s | 2129 MB |

- **Save time** runs from the start of a save's first `write_file` call to the end of its last call. The copy itself took under 80 ms.
- **Host UI thread:** a separate process sent `WM_NULL` to the app window every 20 ms. The table shows the longest round trip, and the sum of the round trips that took over 50 ms.
- **Peak memory** is the sum of private bytes over the host and all WebView2 processes.

This halves the time and the data sent per save. It doesn't lower the peak memory for large saves, because the peak comes from the one remaining large IPC body. #PR_3 deals with that by sending the save in chunks.

On this branch, `pnpm check` (0 errors), `pnpm build` and `pnpm test` (239 passed) pass.

## Additional Notes

- The "after" build in the table also contained the stream fix (#PR_1) and the `lowLevelAccess` fix (#PR_4). Neither has any effect in this test: there is no streaming, and the bot doesn't use low level access.
- Most of this change, and the measurements above, were produced with an AI assistant (Claude Code). The Windows numbers come from a benchmark workflow in my fork: https://github.com/SameDesu123/Risuai/actions/runs/37277004049

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012gh4XeiASSGgQZowZWFKHT
