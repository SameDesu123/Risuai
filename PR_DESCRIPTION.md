# PR Title

feat: add `optional` setting type and migrate Ooba params to SettingRenderer

# PR Body

## Summary

Adds an `optional` type to the data-driven settings system so `OptionalInput` (checkbox + input, `null` when unchecked) can be declared as data, then uses it to migrate the Ooba settings page.

- `src/ts/setting/types.ts`: new `'optional'` `SettingType` and `optionalMode?: 'text' | 'number' | 'bool'` option (initial value when enabled: `""`, `0`, or `false`; default `'text'`)
- `src/lib/Setting/Wrappers/SettingOptional.svelte`: wrapper following the same sync / guarded write-back pattern as the other wrappers
- `src/ts/setting/settingRegistry.ts`: registers the wrapper
- `src/ts/setting/oobaSettingsData.ts`: the 41 Ooba args as data (`oobaPromptSettingsItems`, `oobaParameterSettingsItems`); mode-dependent prompt args use `condition` instead of `{#if}` blocks
- `src/lib/Setting/Pages/OobaSettings.svelte`: replaces the hand-written label + `OptionalInput` rows with two `SettingRenderer` calls

No visual change: same label span, same `OptionalInput` with `marginBottom`, same order and same mode conditions. The Ooba mode select and custom stop strings are left as-is.

## Test plan

- [x] `pnpm check`: 0 errors, 0 warnings
- [x] `pnpm test`: 27 files passed
- [x] Rendered `SettingOptional` in a throwaway happy-dom test: checking a `number` item writes `0`, unchecking writes `null`, a `bool` item shows the True/False buttons, and the prompt-arg conditions match `instruct` / `chat` / `chat-instruct`
- [ ] Manually open Ooba settings and toggle a few args

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_015yEypYx8uKFco4GH3zE2gJ
