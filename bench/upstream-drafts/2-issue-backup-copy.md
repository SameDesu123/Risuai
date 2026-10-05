**Title:** Desktop (Tauri): every save sends the whole database over IPC twice

---

### What happens

On the desktop build, every `saveDb()` sends the full encoded save from the webview to the Rust side twice. It goes once to `database/database.bin`, and once more to the new `database/dbbackup-<time>.bin`:

```ts
await writeFile('database/database.bin', dbData, { baseDir: BaseDirectory.AppData });
await writeFile(`database/dbbackup-${(Date.now() / 100).toFixed()}.bin`, dbData, { baseDir: BaseDirectory.AppData });
```

(`saveDb()` in `src/ts/globalApi.svelte.ts`)

The second transfer carries bytes that are already on disk, and IPC request bodies are expensive in the desktop app. On Windows, WebView2 and the Tauri host copy each body several times on its way to the command. While a write is in flight, the WebView2 browser process commits about 20 times the body size and the Tauri host about 10 times. wry also reads the body on the window's UI thread.

So every save pays twice the time, twice the memory churn and twice the UI-thread stall it needs. Saves run after every change: Lua and trigger variable updates, edits, new messages. With a save of tens of MB (many characters with long chats, with cold storage off), this adds up quickly.

### Measurements

These are from a GitHub Actions `windows-latest` runner (4 vCPU, 16 GB) with WebView2 153. A Lua button that changes chat variables is clicked 8 times, and each click causes a save. A save is timed from the start of its first `write_file` call to the end of its last call.

| save size | median save, current `main` | median save, backup copied on the Rust side |
|---|---|---|
| 16 MB | 773 ms | 417 ms |
| 40 MB | 2010 ms | 1040 ms |
| 64 MB | 2630 ms | 1368 ms |

On Linux (WebKitGTK), strace shows the same thing: one 41 MB `write()` to `database.bin`, then a second 41 MB `write()` to the backup. Both came through IPC.

### Suggested fix

Write `database.bin` once, then copy it to the backup with plugin-fs `copyFile`. That permission is already granted: `fs:allow-copy-file`, scope `$APPDATA/**/*`. The copy runs on the Rust side and took under 80 ms for these sizes on the same runner. The backup is byte-identical to `database.bin`, and backup naming and pruning stay the same. I have a PR ready.

_I found and measured this with the help of an AI assistant (Claude Code)._
