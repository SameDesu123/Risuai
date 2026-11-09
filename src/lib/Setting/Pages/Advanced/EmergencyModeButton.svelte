<script lang="ts">
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { language } from "src/lang";
    import { EmergencyModeStore, restartApp } from "src/ts/emergencyMode";
    import { isTauri } from "src/ts/platform";
</script>

<span class="text-textcolor mt-6">{language.emergencyMode.title}</span>
<span class="text-textcolor2 text-sm mt-1">{language.emergencyMode.settingDesc}</span>
{#if !isTauri}
    <span class="text-textcolor2 text-sm mt-1">{language.emergencyMode.urlHint}</span>
{/if}
{#if $EmergencyModeStore}
    <Button className="mt-2" onclick={() => {
        restartApp(false)
    }}>
        {language.emergencyMode.exit}
    </Button>
{:else}
    <Button className="mt-2" styled="danger" onclick={() => {
        restartApp(true)
    }}>
        {language.emergencyMode.restartInEmergency}
    </Button>
{/if}
