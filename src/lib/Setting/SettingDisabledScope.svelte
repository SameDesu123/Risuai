<script lang="ts">
    interface Props {
        disabled: boolean;
        children: import('svelte').Snippet;
    }

    let { disabled, children }: Props = $props();
</script>

<!--
    Natively disables every form control inside (input, select, textarea, button)
    without changing layout (`display: contents`).
-->
<fieldset {disabled} class="contents {disabled ? '*:opacity-50 *:cursor-not-allowed' : ''}">
    {@render children()}
</fieldset>
