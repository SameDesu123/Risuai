**Title:** Desktop (Tauri): a large save spikes memory by GBs and stalls the window on Windows; database.bin is overwritten in place

---

### What happens

`saveDb()` sends the whole save to the Rust side in a single `writeFile()` call. On Windows, one large IPC request body is very expensive:

- **Memory.** While a body is in flight, the WebView2 browser process commits about 20 times its size and the Tauri host about 10 times. I measured this over a bare CDP connection, without DevTools or Playwright instrumentation. A 64 MB write peaks at about 1.27 GB in the browser process and 620 MB in the host. A 256 MB write peaks at 4.9 GB and 2.4 GB.
- **UI thread.** wry reads the body on the window's UI thread, so the window stops responding while it is copied (about 130 ms for 64 MB and 590 ms for 256 MB on a 4-vCPU runner).

With a save of 40-64 MB, each save briefly adds 0.6-1 GB to the process tree (see below). A save can reach that size when cold storage is off and there are many characters with long chats. On machines with 8-16 GB of RAM this plausibly contributes to the out-of-memory crashes people report on the desktop build.

There is a second, separate problem: `database.bin` is overwritten in place (truncate, then write). If the app is killed or crashes in that window, `database.bin` is left truncated. A truncated save still decodes without an error, because `RisuSaveDecoder` skips blocks it can't read; it simply has no characters after the cut. So the loader's fallback to `dbbackup-*.bin`, which only runs when decoding throws, never kicks in. After that, each new save writes another backup of the truncated state, and `getDbBackups()` keeps only the newest 20.

I checked this by cutting a 10-character save to a fraction of its bytes and decoding it:

| bytes kept | 100% | 90% | 75% | 50% | 25% | 5% | 0.1% |
|---|---|---|---|---|---|---|---|
| characters loaded | 10 | 8 | 7 | 4 | 2 | 0 | 0 |
| threw an error | no | no | no | no | no | no | no |

### Measurements

These are from a GitHub Actions `windows-latest` runner (4 vCPU, 16 GB) with WebView2 153. A Lua button that changes chat variables is clicked 8 times, and each click causes a save. All builds here already copy the backup on the Rust side (#ISSUE_2), so each save sends the database over IPC once.

| save size | | median save time | host UI thread: longest stall / total stalled | peak private memory (whole app) | of which WebView2 browser process |
|---|---|---|---|---|---|
| 40 MB | one `writeFile` | 1040 ms | 129 ms / 0.77 s | 1496 MB | 797 MB |
| | 8 MB chunks | 905 ms | 31 ms / 0.00 s | 889 MB | 175 MB |
| | web build (Edge) | | | 925 MB | |
| 64 MB | one `writeFile` | 1368 ms | 156 ms / 0.83 s | 2129 MB | 1243 MB |
| | 8 MB chunks | 918 ms | 25 ms / 0.00 s | 1089 MB | 154 MB |
| | web build (Edge) | | | 1074 MB | |

### Suggested fix

- Send the save in chunks of at most 8 MB to `database/database.bin.tmp` (plugin-fs `writeFile` with `append`).
- Then `rename` the temporary file over `database.bin`. If the rename fails, for example because another program holds the file open, fall back to `copyFile`.

With this, the window stays responsive and peak memory falls to the level of the web build. `database.bin` is also always either the previous complete save or the new one. Both permissions are already granted. I have a PR ready.

_I found and measured this with the help of an AI assistant (Claude Code)._
