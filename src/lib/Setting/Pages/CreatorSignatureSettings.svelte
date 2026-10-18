<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from 'src/ts/stores.svelte';
    import Button from "src/lib/UI/GUI/Button.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm, alertError, alertNormal } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { exportSigningKeyFile, generateSigningKey, parseSigningKeyFile } from "src/ts/creatorSignature";

    let newName = $state('')

    async function createKey() {
        if(!newName.trim()){
            alertError(language.creatorSignature.nameRequired)
            return
        }
        DBState.db.creatorSigningKey = await generateSigningKey(newName.trim())
        newName = ''
    }

    async function importKey() {
        if(DBState.db.creatorSigningKey && !(await alertConfirm(language.creatorSignature.replaceConfirm))){
            return
        }
        const selected = await selectSingleFile(['json'])
        if(!selected){
            return
        }
        try {
            DBState.db.creatorSigningKey = await parseSigningKeyFile(new TextDecoder().decode(selected.data))
            alertNormal(language.successImport)
        } catch (error) {
            console.error(error)
            alertError(language.creatorSignature.invalidKeyFile)
        }
    }

    async function exportKey() {
        await downloadFile('creator-signing-key.json', exportSigningKeyFile($state.snapshot(DBState.db.creatorSigningKey)))
    }

    async function deleteKey() {
        if(await alertConfirm(language.creatorSignature.deleteConfirm)){
            DBState.db.creatorSigningKey = null
        }
    }
</script>

<div class="bg-darkbg p-3 rounded-md mb-2 flex flex-col items-start mt-2">
    <h1 class="text-2xl font-black">{language.creatorSignature.title}</h1>
    <span class="text-textcolor2 text-sm mt-1">{language.creatorSignature.description}</span>
    {#if DBState.db.creatorSigningKey}
        <span class="text-textcolor mt-4">{language.creatorSignature.signerName}</span>
        <TextInput size="sm" fullwidth bind:value={DBState.db.creatorSigningKey.name} />
        <span class="text-textcolor2 text-sm mt-2">{language.creatorSignature.authorId}: <span class="font-mono text-textcolor">{DBState.db.creatorSigningKey.authorId}</span></span>
        <span class="text-draculared text-xs mt-2">{language.creatorSignature.keyWarning}</span>
        <div class="flex flex-wrap gap-2 mt-2">
            <Button size="sm" onclick={exportKey}>{language.creatorSignature.exportKey}</Button>
            <Button size="sm" onclick={importKey}>{language.creatorSignature.importKey}</Button>
            <Button size="sm" styled="danger" onclick={deleteKey}>{language.creatorSignature.deleteKey}</Button>
        </div>
    {:else}
        <span class="text-textcolor mt-4">{language.creatorSignature.signerName}</span>
        <TextInput size="sm" fullwidth bind:value={newName} />
        <div class="flex flex-wrap gap-2 mt-2">
            <Button size="sm" onclick={createKey}>{language.creatorSignature.createKey}</Button>
            <Button size="sm" onclick={importKey}>{language.creatorSignature.importKey}</Button>
        </div>
    {/if}
</div>
