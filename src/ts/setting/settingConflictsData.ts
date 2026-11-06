/**
 * Setting Conflict Rules
 *
 * While `when` returns true, every item listed in `disables` is disabled and
 * shows a yellow warning icon next to its label. Clicking the icon opens the
 * reason (`messageKey`) in a modal. No UI code needs to change.
 *
 * To add a new conflict:
 *   1. Add the reason to `settingConflict.messages` in src/lang/en.ts.
 *   2. Add a rule object to `settingConflictRules` below, referencing SettingItem ids.
 *   Unknown item ids are reported in the dev console.
 */

import type { SettingConflictRule } from './types';

export const settingConflictRules: SettingConflictRule[] = [
    {
        // Remove Incomplete Sentences trims to the last punctuation, so punctuation-based auto continue never fires.
        id: 'removeIncomplete-autoContinue',
        disables: ['adv.autoCont'],
        when: (ctx) => ctx.db.removeIncompleteResponse,
        messageKey: 'autoContinueRemoveIncomplete',
    },
    {
        // The batch API does not support streaming (see process/request/anthropic.ts).
        id: 'streaming-claudeBatching',
        disables: ['adv.claudeBatch'],
        when: (ctx) => ctx.db.useStreaming,
        messageKey: 'claudeBatchingStreaming',
    },
];
