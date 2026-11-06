/**
 * Setting conflict lookup utilities.
 * Rules are declared in settingConflictsData.ts.
 */

import type { SettingConflictRule, SettingContext, SettingItem } from './types';
import { settingConflictRules } from './settingConflictsData';
import { getFullSettingsData } from './utils';
import { languageSettingsItems } from './languageSettingsData.svelte';

/** itemId → rules that can disable the item */
const rulesByItemId = new Map<string, SettingConflictRule[]>();
for (const rule of settingConflictRules) {
    for (const id of rule.disables) {
        const list = rulesByItemId.get(id);
        if (list) {
            list.push(rule);
        } else {
            rulesByItemId.set(id, [rule]);
        }
    }
}

let validated = false;

function collectIds(items: SettingItem[], out: Set<string>) {
    for (const item of items) {
        if (!item) continue;
        out.add(item.id);
        if (item.options?.children) {
            collectIds(item.options.children, out);
        }
    }
}

/** Dev-only: report duplicate rule ids and unknown setting ids once. */
function validateRules() {
    if (validated) return;
    validated = true;
    const ids = new Set<string>();
    collectIds(getFullSettingsData().concat(languageSettingsItems), ids);
    const seen = new Set<string>();
    for (const rule of settingConflictRules) {
        if (seen.has(rule.id)) {
            console.warn(`[settingConflicts] Duplicate rule id "${rule.id}"`);
        }
        seen.add(rule.id);
        for (const id of rule.disables) {
            if (!ids.has(id)) {
                console.warn(`[settingConflicts] Rule "${rule.id}" references unknown setting id "${id}"`);
            }
        }
    }
}

/** Rules currently disabling the item. Reactive when called from a template or $derived. */
export function getActiveConflicts(item: SettingItem, ctx: SettingContext): SettingConflictRule[] {
    if (import.meta.env.DEV) validateRules();
    const rules = rulesByItemId.get(item.id);
    if (!rules) return [];
    return rules.filter((rule) => rule.when(ctx));
}
