<script lang="ts">
    import CheckInput from "./CheckInput.svelte";
    import NumberInput from "./NumberInput.svelte";
    import TextInput from "./TextInput.svelte";
    interface Props {
        value: string|number|boolean;
        numberMode?: boolean;
        boolMode?: boolean;
        marginBottom?: boolean;
        /** id for the text/number input, so an external <label for> can name it */
        id?: string;
        /** id of the element labelling the True/False group in boolMode */
        labelledby?: string;
    }

    let {
        value = $bindable(),
        numberMode = false,
        boolMode = false,
        marginBottom = false,
        id = undefined,
        labelledby = undefined
    }: Props = $props();
    const valToggle = () => {
            value = !value
    }
</script>

<div class="flex items-center justify-center" class:mb-4={marginBottom}>
    <div class="flex justify-center items-center border-darkborderc rounded-l-md rounded-t-md rounded-b-md border h-full">
        <CheckInput hiddenName check={!(value === null || value === undefined)} onChange={() => {
            if(value === null || value === undefined){
                if(numberMode){
                    value = 0
                }
                else if(boolMode){
                    value = false
                }
                else{
                    value = ""
                }
            }
            else{
                value = null
            }
        }} />
    </div>

    {#if (value === null || value === undefined)}
        <TextInput value={"Using default"} {id} className="flex-1" disabled/>
    {:else if typeof(value) === 'string'}
        <TextInput bind:value={value} {id} className="flex-1"/>
    {:else if typeof(value) === 'number'}
        <NumberInput bind:value={value} {id} className="flex-1"/>
    {:else if typeof(value) === 'boolean'}
        <div class="flex flex-1" role="group" aria-labelledby={labelledby}>
            <button type="button" class="px-2 py-2 border border-darkborderc flex-1" class:text-textcolor2={!value} aria-pressed={value} onclick={valToggle}>True</button>
            <button type="button" class="px-2 py-2 border border-darkborderc flex-1" class:text-textcolor2={value} aria-pressed={!value} onclick={valToggle}>False</button>
        </div>
    {:else}
        <TextInput value={"Using default"} {id} className="flex-1" disabled/>
    {/if}
</div>