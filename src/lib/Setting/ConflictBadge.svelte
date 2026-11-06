<script lang="ts">
    import { CircleAlertIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertMd } from "src/ts/alert";

    interface Props {
        /** Translated reasons the setting is disabled */
        reasons: string[];
        name?: string;
    }

    let { reasons, name = '' }: Props = $props();

    let body = $derived(`**${language.settingConflictTitle}**\n\n` + reasons.map((r) => `- ${r}`).join('\n'));
</script>

<button
    type="button"
    class="relative inline-flex items-center cursor-pointer text-draculared hover:text-green-500"
    style="vertical-align: -0.2em;"
    title={`${language.settingConflictTitle}\n${reasons.join('\n')}`}
    aria-label={`${name} ${language.settingConflictTitle}`}
    onclick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        alertMd(body)
    }}
>
    <CircleAlertIcon size={16} strokeWidth={2.25} />
</button>
