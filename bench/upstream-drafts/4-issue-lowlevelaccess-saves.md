**Title:** Scrolling through the chat of a bot with low level access re-saves the whole database

---

### What happens

For a character with **low level access** enabled, just rendering chat messages, for example scrolling up to load older ones, marks the save as changed. The whole database is then written out again, although nothing has changed. A bot without low level access doesn't do this.

Low level access is what lets a bot's Lua make LLM or network requests, so it is often enabled on complex Lua bots. With a large save, each of these extra saves is expensive (see below).

### Cause

Two functions that run on every rendered message write into the character's own trigger objects, which are part of the saved data:

`runLuaEditTrigger()` in `src/ts/process/scriptings.ts`:

```ts
const triggers = char.type === 'group' ? (getModuleTriggers()) : (char.triggerscript.map((v) => {
    v.lowLevelAccess = false
    return v
}).concat(getModuleTriggers()))
```

`runTrigger()` in `src/ts/process/triggers.ts` (in display mode, `char` is not cloned):

```ts
const triggers = char.triggerscript.map((v) => {
    v.lowLevelAccess = CharacterlowLevelAccess
    return v
}).concat(getModuleTriggers())
```

`ParseMarkdown()` calls `processScriptFull(…, 'editdisplay')`, which calls `runLuaEditTrigger()` and then `runTrigger(currentChar, 'display', { displayMode: true })` on the character in `DBState.db`. For a character with `lowLevelAccess: true`, each render therefore sets every trigger's `lowLevelAccess` to `false` and then back to `true`.

The save loop in `saveDb()` watches the selected character with `$state.snapshot()`, so each flip schedules a save, and the save writes the whole database again. For a character without low level access, both functions write `false`, so nothing changes after the first render.

`runLuaButtonTrigger()` in the same file already does this without mutating anything:

```ts
char.triggerscript.map<triggerscript>((v) => ({
    ...v,
    lowLevelAccess: char.type !== 'simple' ? char.lowLevelAccess ?? false : false
}))
```

### Measurements

The test opens a chat with 30 messages shown and scrolls up 8 times, 2.5 s apart, until 150 messages are rendered. No variables or messages change.

| | low level access off | low level access on |
|---|---|---|
| Linux desktop build (WebKitGTK): saves during the 8 scrolls | 0 | 8 (16 database file writes) |

On a GitHub Actions `windows-latest` runner (WebView2 153), with a 16 MB save and low level access on, the same 8 scrolls caused:

- 8 saves, 715 ms each (median), sending 254 MB over IPC in total (each save goes over IPC twice, see #ISSUE_2);
- a total of 0.83 s of UI-thread stalls over 50 ms;
- peak private memory of 939 MB for the whole app.

With trigger copies instead of mutations, there were no saves, no stalls, and peak memory was 491 MB.

I only measured the desktop build. The code is shared, so I expect the web and node-hosted builds to re-save the same way, but I haven't measured them.

### Suggested fix

Build the trigger lists from copies, as `runLuaButtonTrigger()` already does. The Lua runtime still gets the same `lowLevelAccess` value. I have a PR ready.

_I found and measured this with the help of an AI assistant (Claude Code)._
