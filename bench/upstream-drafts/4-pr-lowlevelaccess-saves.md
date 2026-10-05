**Title:** fix: stop writing lowLevelAccess into the character's saved triggers

**Branch:** `fix/lowlevelaccess-trigger-copy` (1 commit on `main`)

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

`runLuaEditTrigger()` and `runTrigger()` in display mode set `lowLevelAccess` on the trigger objects of the character in the save itself. `runLuaEditTrigger()` sets it to `false`, and `runTrigger()` to the character's own setting. Both run for every rendered message. For a character with low level access enabled, the flag therefore flips back and forth, and each flip makes `saveDb()` write the whole database again, just from scrolling through a chat.

This PR builds both trigger lists from copies, as `runLuaButtonTrigger()` already does.

## Related Issues

Closes #ISSUE_4

## Changes

- `runLuaEditTrigger()` (`src/ts/process/scriptings.ts`) and `runTrigger()` (`src/ts/process/triggers.ts`):

  ```ts
  // before
  char.triggerscript.map((v) => {
      v.lowLevelAccess = CharacterlowLevelAccess
      return v
  })
  // after
  char.triggerscript.map<triggerscript>((v) => ({
      ...v,
      lowLevelAccess: CharacterlowLevelAccess
  }))
  ```

  `runLuaEditTrigger()` gets the same change with `false`.
- Tests:
  - `src/ts/process/scriptings.test.ts`: `runLuaEditTrigger` leaves the character's trigger objects untouched.
  - New `src/ts/process/triggers.test.ts`: `runTrigger` in display mode leaves the character's trigger objects untouched. A second test checks that a Lua trigger still runs with the character's `lowLevelAccess`.

## Impact

- **Behavior.** Scripts and trigger effects get the same `lowLevelAccess` value as before:
  - `runLuaEditTrigger()` passes `lowLevelAccess: false` to `runScripted()` explicitly;
  - `runTrigger()` reads `trigger.lowLevelAccess` from the copies, which carry the same value the old code wrote.

  The UI and character export use the character-level `lowLevelAccess`, not the per-trigger field.
- **Saved data.** The only difference is that the per-trigger `lowLevelAccess` field is no longer written into the saved triggers.
- **Platforms.** This code is shared, so the change applies to the web, desktop and node-hosted builds.

The test opens a chat with 30 messages shown and scrolls up 8 times, 2.5 s apart, until 150 messages are rendered. No variables or messages change.

| saves during the 8 scrolls | before | after |
|---|---|---|
| Linux desktop build (WebKitGTK), low level access on | 8 (16 database file writes) | 0 |
| Linux desktop build, same bot with low level access off | 0 | 0 |

On a GitHub Actions `windows-latest` runner (WebView2 153), with a 16 MB save and low level access on:

| | saves | median save time | sent over IPC | host UI thread: longest stall / total stalled | peak private memory (whole app) |
|---|---|---|---|---|---|
| before | 8 | 715 ms | 254 MB | 77 ms / 0.83 s | 939 MB |
| after | 0 | | 0 MB | 11 ms / 0.00 s | 491 MB |

- **Host UI thread:** a separate process sent `WM_NULL` to the app window every 20 ms. The table shows the longest round trip, and the sum of the round trips that took over 50 ms.
- **Peak memory** is the sum of private bytes over the host and all WebView2 processes.

I only measured the desktop build. The web and node-hosted builds run the same code, so I expect them to stop re-saving too, but I haven't measured them.

On this branch, `pnpm check` (0 errors), `pnpm build` and `pnpm test` (242 passed) pass.

## Additional Notes

- `getModuleTriggers()` (`src/ts/process/modules.ts`) also writes `lowLevelAccess` into the module's trigger objects. I left it as is, because it always writes the same value for a given module, so it never flips and doesn't cause repeated saves.
- The "after" build on Windows also contained #PR_1, #PR_2 and #PR_3. They only change how a stream is read and how a save is written, so they have nothing to do in a test with no streaming and no saves.
- Most of this change, and the measurements above, were produced with an AI assistant (Claude Code). The Windows numbers come from a benchmark workflow in my fork: https://github.com/SameDesu123/Risuai/actions/runs/37277004049

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_012gh4XeiASSGgQZowZWFKHT
