**Title:** perf(tauri): send the save over IPC in 8 MB chunks and rename it into place

**Branch:** `perf/tauri-chunked-save` (2 commits on `main`: the commit from #PR_2, then this change)

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

On desktop, `saveDb()` sends the whole save to the Rust side in a single `writeFile()` call. On Windows, one large IPC request body is very expensive. While it is in flight, the WebView2 browser process commits about 20 times its size and the Tauri host about 10 times, and wry reads it on the window's UI thread.

This PR sends the save in chunks of at most 8 MB to a temporary file, then renames that file over `database.bin`. The window stays responsive, peak memory falls to the web build's level, and `database.bin` is never left half-written.

This branch also contains the commit from #PR_2, because both PRs change the same lines of `saveDb()`. Merging this PR alone brings in both changes. If #PR_2 is merged first, this diff shrinks to the chunking change.

## Related Issues

Closes #ISSUE_3

## Changes

- **New `src/ts/storage/tauriWrite.ts`** with `replaceFileInChunks(path, data, chunkSize = 8 * 1024 * 1024)`:
  - It writes `data` to `<path>.tmp` with plugin-fs `writeFile`, at most `chunkSize` bytes per call. The first call truncates the file and the rest use `append: true`, so a `.tmp` left behind by an interrupted save is simply overwritten.
  - It then `rename`s `<path>.tmp` over `<path>`. If the rename throws (for example because another program holds `database.bin` open on Windows), it logs the error and `copyFile`s the temporary file over the target instead.
- **`saveDb()`, Tauri branch** (`src/ts/globalApi.svelte.ts`): `writeFile('database/database.bin', dbData, …)` becomes `replaceFileInChunks('database/database.bin', dbData)`. The backup copy from #PR_2 runs after it, unchanged.
- **New `src/ts/storage/tauriWrite.test.ts`**: six unit tests, with plugin-fs mocked by an in-memory map. They cover:
  - the chunk sequence and the rename;
  - no empty trailing chunk when the size is a multiple of the chunk size;
  - an empty file;
  - a leftover `.tmp`;
  - the copy fallback;
  - a failed chunk leaving the target untouched.

`fs:allow-write-file`, `fs:allow-rename` and `fs:allow-copy-file` with the `$APPDATA/**/*` scope are already granted in `src-tauri/capabilities/migrated.json`, so no capability change is needed.

## Impact

- **Scope.** Only the Tauri desktop build is affected. The save format and the bytes in `database.bin` are unchanged.
- **Temporary file.** `database/database.bin.tmp` exists while a save is being written. The rename removes it. If the copy fallback was used, it stays until the next save overwrites it. Loading reads only `database.bin`, and `getDbBackups()` only looks at `dbbackup-*` names, so the temporary file is never picked up.
- **IPC calls.** A save under 8 MB now takes three IPC calls instead of two: write, rename, backup copy.
- **Rename.** plugin-fs `rename` is a synchronous command, so it runs on the main thread. On the Windows runner it took 17-22 ms per save, with one outlier of 110 ms.
- **Durability.** There is no fsync before the rename, as there was none before. This protects `database.bin` from a save cut short by a crash or by closing the app. It does not protect against a power cut.

Measured on a GitHub Actions `windows-latest` runner (4 vCPU, 16 GB) with WebView2 153. A Lua button that changes chat variables is clicked 8 times on a save of the given size, and each click causes a save. "#PR_2" means current `main` plus #PR_2, and "this PR" means #PR_2 plus this change.

| save size | build | median save time | host UI thread: longest stall / total stalled | peak private memory (whole app) | of which browser process |
|---|---|---|---|---|---|
| 16 MB | current `main` | 773 ms | 77 ms / 0.77 s | 1017 MB | 351 MB |
| | #PR_2 | 417 ms | 117 ms / 0.41 s | 853 MB | 288 MB |
| | this PR | 398 ms | 84 ms / 0.08 s | 742 MB | 185 MB |
| | web build (Edge) | | 16 ms / 0.00 s | 897 MB | 67 MB |
| 40 MB | current `main` | 2010 ms | 126 ms / 1.10 s | 1451 MB | 798 MB |
| | #PR_2 | 1040 ms | 129 ms / 0.77 s | 1496 MB | 797 MB |
| | this PR | 905 ms | 31 ms / 0.00 s | 889 MB | 175 MB |
| | web build (Edge) | | 68 ms / 0.07 s | 925 MB | 71 MB |
| 64 MB | current `main` | 2630 ms | 160 ms / 1.13 s | 1952 MB | 1238 MB |
| | #PR_2 | 1368 ms | 156 ms / 0.83 s | 2129 MB | 1243 MB |
| | this PR | 918 ms | 25 ms / 0.00 s | 1089 MB | 154 MB |
| | web build (Edge) | | 18 ms / 0.00 s | 1074 MB | 72 MB |

- **Save time** runs from the start of a save's first `write_file` call to the end of its last database call (write, rename or copy).
- **Host UI thread:** a separate process sent `WM_NULL` to the app window every 20 ms. The table shows the longest round trip, and the sum of the round trips that took over 50 ms. For the web build, this is the Edge window.
- **Peak memory** is the sum of private bytes over the host and all WebView2 processes (all Edge processes for the web build). The last column is the share of the WebView2 (or Edge) browser process at that peak.

Tauri's IPC switches to `postMessage` for the rest of the page's life once a custom-protocol request fails, and from then on every request body is serialized to JSON. I also forced that state on the 16 MB save. The longest UI stall was 1587 ms on current `main` and 1496 ms with #PR_2, and 759 ms with this PR. Peak memory was 1789 MB and 1874 MB, and 1130 MB with this PR.

On Linux (WebKitGTK), strace of one 41 MB save with this PR shows the expected sequence:

1. four 8 MiB writes and a 7.6 MB remainder to `database.bin.tmp` (the first opened with `O_TRUNC`, the rest with `O_APPEND`);
2. `rename(database.bin.tmp, database.bin)`;
3. the in-kernel `copy_file_range` backup from #PR_2.

After a restart the app loads the save as before. No `.tmp` is left behind, and the backup is byte-identical to `database.bin`.

On this branch, `pnpm check` (0 errors), `pnpm build` and `pnpm test` (245 passed) pass.

## Additional Notes

- A truncated `database.bin` still decodes without an error, because `RisuSaveDecoder` skips blocks it can't read, so the loader never falls back to a backup (details in #ISSUE_3). This PR stops the app from producing such a file. Making the loader detect one could be a separate follow-up.
- The "this PR" build in the table also contained the stream fix (#PR_1) and the `lowLevelAccess` fix (#PR_4). Neither has any effect in this test: there is no streaming, and the bot doesn't use low level access.
- Most of this change, and the measurements above, were produced with an AI assistant (Claude Code). The Windows numbers come from a benchmark workflow in my fork: https://github.com/SameDesu123/Risuai/actions/runs/37277004049

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012gh4XeiASSGgQZowZWFKHT
