<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from 'src/ts/stores.svelte';
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import { changeColorScheme, colorSchemeList, updateTextThemeAndCSS } from "src/ts/gui/colorscheme";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { CustomGUISettingMenuStore } from "src/ts/stores.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { displayThemeItems, displaySizeSpeedItems, displayOthersItems } from "src/ts/setting/displaySettingsData";

    const onSchemeInputChange = (e:Event) => {
        changeColorScheme((e.target as HTMLInputElement).value)
    }

    let submenu = $state(DBState.db.useLegacyGUI ? -1 : 0)
</script>

<h2 class="mb-2 text-2xl font-bold mt-2">{language.display}</h2>

{#if submenu !== -1}
    <div class="flex w-full rounded-md border border-darkborderc mb-4 overflow-x-auto h-16 min-h-16 overflow-y-clip">
        <button onclick={() => {
            submenu = 0
        }} class="p-2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 0}>
            <span>{language.theme}</span>
        </button>
        <button onclick={() => {
            submenu = 1
        }} class="p2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 1}>
            <span>{language.sizeAndSpeed}</span>
        </button>
        <button onclick={() => {
            submenu = 2
        }} class="p-2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 2}>
            <span>{language.others}</span>
        </button>
    </div>
{/if}

{#if submenu === 0 || submenu === -1}
    <!-- Theme Selection (kept inline due to complex conditional UI) -->
    <span class="text-textcolor mt-4">{language.theme}</span>
    <SelectInput className="mt-2" bind:value={DBState.db.theme}>
        <OptionInput value="" >Standard Risu</OptionInput>
        <OptionInput value="waifu" >Waifulike</OptionInput>
        <OptionInput value="mobilechat" >Mobile Chat</OptionInput>
        <OptionInput value="cardboard" >CardBoard</OptionInput>
        <OptionInput value="customHTML" >Custom HTML</OptionInput>
    </SelectInput>

    {#if DBState.db.theme === "custom"}
        <Button className="mt-2" onclick={() => {
            CustomGUISettingMenuStore.set(true)
        }}>{language.defineCustomGUI}</Button>
    {/if}

    {#if DBState.db.theme === 'customHTML'}
        <span class="text-textcolor mt-4">{language.chatHTML} <Help key="chatHTML"/></span>
        <TextAreaInput bind:value={DBState.db.guiHTML} />
    {/if}

    {#if DBState.db.theme === "waifu"}
        <span class="text-textcolor mt-4">{language.waifuWidth}</span>
        <SliderInput min={50} max={200} bind:value={DBState.db.waifuWidth} />
        <span class="text-textcolor2 text-sm">{(DBState.db.waifuWidth)}%</span>

        <span class="text-textcolor mt-4">{language.waifuWidth2}</span>
        <SliderInput min={20} max={150} bind:value={DBState.db.waifuWidth2} />
        <span class="text-textcolor2 text-sm">{(DBState.db.waifuWidth2)}%</span>
    {/if}

    <!-- Color Scheme (dynamic options) -->
    <span class="text-textcolor mt-4">{language.colorScheme}</span>
    <SelectInput className="mt-2" value={DBState.db.colorSchemeName} onchange={onSchemeInputChange}>
        {#each colorSchemeList as scheme}
            <OptionInput value={scheme} >{scheme}</OptionInput>
        {/each}
        <OptionInput value="custom" >Custom</OptionInput>
    </SelectInput>

    <!-- Color Scheme Editor (custom component) -->
    <SettingRenderer items={displayThemeItems.filter(item => item.id === 'disp.colorSchemeEditor')} />

    <!-- Text Color -->
    <span class="text-textcolor mt-4">{language.textColor}</span>
    <SelectInput className="mt-2" bind:value={DBState.db.textTheme} onchange={updateTextThemeAndCSS}>
        <OptionInput value="standard" >{language.classicRisu}</OptionInput>
        <OptionInput value="highcontrast" >{language.highcontrast}</OptionInput>
        <OptionInput value="custom" >Custom</OptionInput>
    </SelectInput>

    <!-- Text Theme Editor (custom component) -->
    <SettingRenderer items={displayThemeItems.filter(item => item.id === 'disp.textThemeEditor')} />

    <!-- Font -->
    <span class="text-textcolor mt-4">{language.font}</span>
    <SelectInput className="mt-2" bind:value={DBState.db.font} onchange={updateTextThemeAndCSS}>
        <OptionInput value="default" >Default</OptionInput>
        <OptionInput value="timesnewroman" >Times New Roman</OptionInput>
        <OptionInput value="custom" >Custom</OptionInput>
    </SelectInput>

    {#if DBState.db.font === "custom"}
        <TextInput bind:value={DBState.db.customFont} onchange={updateTextThemeAndCSS} />
    {/if}
{/if}

{#if submenu === 1 || submenu === -1}
    <!-- Size and Speed Tab: Now data-driven with SettingRenderer -->
    <SettingRenderer items={displaySizeSpeedItems} />
{/if}

{#if submenu === 2 || submenu === -1}
    <!-- Others Tab: Use SettingRenderer for all checkbox items -->
    <SettingRenderer items={displayOthersItems.filter(item => 
        item.id !== 'disp.customQuotes'
    )} />

    <!-- Custom Quotes with conditional inputs (kept inline due to array binding) -->
    {#if DBState.db.customQuotes}
        <span class="text-textcolor mt-4">{language.leadingDoubleQuote}</span>
        <TextInput bind:value={DBState.db.customQuotesData[0]} />

        <span class="text-textcolor mt-4">{language.trailingDoubleQuote}</span>
        <TextInput bind:value={DBState.db.customQuotesData[1]} />

        <span class="text-textcolor mt-4">{language.leadingSingleQuote}</span>
        <TextInput bind:value={DBState.db.customQuotesData[2]} />

        <span class="text-textcolor mt-4">{language.trailingSingleQuote}</span>
        <TextInput bind:value={DBState.db.customQuotesData[3]} />
    {/if}

    <!-- Custom CSS -->
    <span class="text-textcolor mt-4">{language.customCSS}<Help key="customCSS" /></span>
    <TextAreaInput bind:value={DBState.db.customCSS} onInput={() => {
        updateTextThemeAndCSS()
    }} />
{/if}