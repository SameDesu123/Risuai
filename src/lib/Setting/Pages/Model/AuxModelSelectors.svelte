<script lang="ts">
  import { DBState } from 'src/ts/stores.svelte'
  import Check from "src/lib/UI/GUI/CheckInput.svelte"
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import { language } from 'src/lang'
  import ModelList from 'src/lib/UI/ModelList.svelte'
  import GridModelOverridePicker from 'src/lib/UI/GridModelOverridePicker.svelte'
</script>

<div class="flex items-center mt-4">
  <Check bind:check={DBState.db.seperateModelsForAxModels} name={language.seperateModelsForAxModels}></Check>
</div>
{#if DBState.db.seperateModelsForAxModels}
  <Check bind:check={DBState.db.doNotChangeSeperateModels} name={language.doNotChangeSeperateModels}></Check>
  <Accordion name={language.axModelsDef} styled>
    <span class="text-textcolor mt-4"> Memory </span>
    <ModelList bind:value={DBState.db.seperateModels.memory} blankable />
    <GridModelOverridePicker modelSlot="memory" provider={DBState.db.seperateModels.memory} />

    <span class="text-textcolor mt-4"> Translations </span>
    <ModelList bind:value={DBState.db.seperateModels.translate} blankable />
    <GridModelOverridePicker modelSlot="translate" provider={DBState.db.seperateModels.translate} />

    <span class="text-textcolor mt-4"> Emotion </span>

    <ModelList bind:value={DBState.db.seperateModels.emotion} blankable />
    <GridModelOverridePicker modelSlot="emotion" provider={DBState.db.seperateModels.emotion} />

    <span class="text-textcolor mt-4"> OtherAx </span>

    <ModelList bind:value={DBState.db.seperateModels.otherAx} blankable />
    <GridModelOverridePicker modelSlot="otherAx" provider={DBState.db.seperateModels.otherAx} />
  </Accordion>
{/if}
