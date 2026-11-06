<script lang="ts">
    import type { SettingConflictRule } from 'src/ts/setting/types';
    import { TriangleAlert } from '@lucide/svelte';
    import { language } from 'src/lang';
    import { alertMd } from 'src/ts/alert';

    interface Props {
        /** Active conflicts for the item; renders nothing when empty */
        conflicts: SettingConflictRule[];
    }

    let { conflicts }: Props = $props();

    function showReason() {
        const reasons = conflicts.map((rule) => language.settingConflict.messages[rule.messageKey]);
        alertMd(`### ${language.settingConflict.title}\n\n${reasons.join('\n\n')}`);
    }
</script>

{#if conflicts.length > 0}
    <button
        type="button"
        class="inline-flex items-center rounded-sm text-warning hover:bg-warning/15 cursor-pointer"
        style="vertical-align: -2px;"
        title={language.settingConflict.title}
        aria-label={language.settingConflict.title}
        onclick={(e) => {
            // Keep clicks from toggling a surrounding <label>
            e.preventDefault();
            e.stopPropagation();
            showReason();
        }}
    >
        <TriangleAlert size={14} aria-hidden="true" />
    </button>
{/if}
