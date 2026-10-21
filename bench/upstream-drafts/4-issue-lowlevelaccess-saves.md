**Title:** Rendering chat messages of a bot with low level access re-saves the whole database

---

### What happens

For a character with **low level access** enabled, just rendering chat messages, for example scrolling up to load older ones, marks the save as changed. The whole database is then written out again (`database.bin` plus a new backup), although nothing has changed. A bot without low level access doesn't do this.

This happens on every platform, because the cause is in shared code. I reproduced it in the web build (Chromium, IndexedDB) and the desktop build (Linux and Windows).

Low level access is what lets a bot's Lua make LLM or network requests, so it is often enabled on complex Lua bots. Those bots also tend to come with large saves, where each of these extra saves is expensive (see below).

### When it happens

Every message that goes through `ParseMarkdown()` triggers it. That includes plain-text messages; the bot doesn't need a Lua UI or an `editDisplay` listener. Some examples:

- scrolling up to load older messages (each page of 15 messages caused one save);
- opening a chat;
- a new or edited message;
- `reloadDisplay()` from Lua or a trigger, which re-renders all visible messages.

The conditions are:

- the character has low level access enabled;
- its `triggerscript` is not empty (any trigger type);
- it is a single-character chat, not a group chat.

Renders that happen close together are merged by the 500 ms save debounce, so a burst causes one save. Scrolling through messages that are already rendered doesn't cause anything.

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

The test imports a RisuRealm bot that uses low level access and has triggers, then imports a 150-message plain-text chat for it. It opens the chat with 30 messages shown and scrolls up 8 times, 2.5 s apart, until all 150 messages are rendered. No variables or messages change. For the "off" column, the same bot is imported and low level access is then unticked in the character settings.

| Saves during the 8 scrolls | low level access off | low level access on | on, with the fix |
|---|---|---|---|
| Web build, Chromium (Playwright), IndexedDB | 0 | 8 | 0 |
| Linux desktop build (WebKitGTK) | 0 | 8 | not measured |

In the web build, each of the 8 saves also wrote a backup, so 16 database writes went to IndexedDB. With a save of only 141 KB, that was 2.2 MB in total. Each web result was repeated at least twice with the same numbers.

On a GitHub Actions `windows-latest` runner (WebView2 153), with a 16 MB save and low level access on, the same 8 scrolls caused:

- 8 saves, 715 ms each (median), sending 254 MB over IPC in total (the desktop build sends the database twice per save, once for `database.bin` and once for the backup);
- a total of 0.83 s of UI-thread stalls over 50 ms;
- peak private memory of 939 MB for the whole app.

With the fix there were no saves, no stalls, and peak memory was 491 MB.

I haven't measured the node-hosted build. It uses the same `saveDb()` path, so I expect each extra save to become a `/api/write` request there.

### Suggested fix

Build the trigger lists from copies, as `runLuaButtonTrigger()` already does. The Lua runtime still gets the same `lowLevelAccess` value, and the stored triggers are left alone. I have a PR ready.

_I found and measured this with the help of an AI assistant (Claude Code)._
