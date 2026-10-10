<script lang="ts">
    import { language } from "src/lang";
    import { hubURL } from "src/ts/characterCards";
    import { loadRisuAccountBackup, loadRisuAccountData, saveRisuAccountData } from "src/ts/drive/accounter";
    
    import { DBState } from 'src/ts/stores.svelte';
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import { alertConfirm} from "src/ts/alert";
    import { forageStorage, loadInternalBackup } from "src/ts/globalApi.svelte";
    import { isTauri, isNodeServer } from "src/ts/platform"
    import { unMigrationAccount } from "src/ts/storage/accountStorage";
    import { checkDriver } from "src/ts/drive/drive";
    import { LoadLocalBackup, SaveLocalBackup, SavePartialLocalBackup } from "src/ts/drive/backuplocal";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { exportAsDataset } from "src/ts/storage/exportAsDataset";
    import { loginToSionyw, testSionywLogin } from "src/ts/sionyw";
    import { cleanColdStorage } from "src/ts/process/coldstorage.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertError, alertInput, alertNormal } from "src/ts/alert";
    import { attributionFingerprint, isValidAttributionSecret, peekLocalAttributionIdentity } from "src/ts/cardAttribution";
    const attributionIdentity = $derived(peekLocalAttributionIdentity(DBState.db))
    let openIframe = $state(false)
    let openIframeURL = $state('')
    let popup:Window = null
</script>

<svelte:window onmessage={async (e) => {
    if(e.origin.startsWith("https://nightly.sv.risuai.xyz") || e.origin.startsWith("https://sv.risuai.xyz") || e.origin.startsWith("http://127.0.0.1") || e.origin === window.location.origin){
        if(e.data.msg?.type === 'drive'){
            await loadRisuAccountData()
            DBState.db.account.data.refresh_token = e.data.msg.data.refresh_token
            DBState.db.account.data.access_token = e.data.msg.data.access_token
            DBState.db.account.data.expires_in = (e.data.msg.data.expires_in * 700) + Date.now()
            await saveRisuAccountData()
            popup.close()
        }
        else if(e.data.msg?.data.vaild){
            openIframe = false
            DBState.db.account = {
                id: e.data.msg.id,
                token: e.data.msg.token,
                data: e.data.msg.data
            }
        }
    }
}}></svelte:window>


<h2 class="mb-2 text-2xl font-bold mt-2">{language.account} & {language.files}</h2>

<Button
    onclick={async () => {
        if(await alertConfirm(language.backupConfirm)){
            SaveLocalBackup()
        }
    }} className="mt-2">
    {language.saveBackupLocal}
</Button>

<Button
    onclick={async () => {
        if(await alertConfirm(language.backupConfirm)){
            SavePartialLocalBackup()
        }
    }} className="mt-2">
    {language.savePartialLocalBackup}
</Button>

<Button
    onclick={async () => {
        if((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))){
            LoadLocalBackup()
        }
    }} className="mt-2">
    {language.loadBackupLocal}
</Button>

{#if !forageStorage.isAccount}
    <Button
        onclick={async () => {
            if((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))){
                loadInternalBackup()
            }
        }} className="mt-2">
        {language.loadInternalBackup}
    </Button>
{:else}
    <Button
        onclick={async () => {
            loadRisuAccountBackup()
        }} className="mt-2">
        {language.loadAutoServerBackup}
    </Button>
{/if}

<Button
    onclick={async () => {
        if(await alertConfirm(language.cleanColdStorageConfirm)){
            cleanColdStorage()
        }
    }} className="mt-2">
    {language.cleanColdStorage}
</Button>

<Button
    onclick={async () => {
        if(await alertConfirm(language.backupConfirm)){
            localStorage.setItem('backup', 'save')
            
            if(isTauri || isNodeServer){
                checkDriver('savetauri')
            }
            else{
                checkDriver('save')
            }
        }
    }} className="mt-2">
    {language.savebackup}
</Button>

<Button
    onclick={async () => {
        if((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))){
            localStorage.setItem('backup', 'load')
            if(isTauri || isNodeServer){
                checkDriver('loadtauri')
            }
            else{
                checkDriver('load')
            }
        }
    }}
    className="mt-2">
    {language.loadbackup}
</Button>

<Button onclick={exportAsDataset} className="mt-2">
    {language.exportAsDataset}
</Button>
<div class="bg-darkbg p-3 rounded-md mb-2 flex flex-col items-start mt-2">
    <div class="w-full">
        <h1 class="text-3xl font-black min-w-0">Risu Account{#if DBState.db.account}
            <button class="bg-selected p-1 text-sm font-light rounded-md hover:bg-blue-500 transition-colors float-right" onclick={async () => {
                if(DBState.db.account.useSync || forageStorage.isAccount){
                    unMigrationAccount()
                }
                
                DBState.db.account = undefined
            }}>{language.logout}</button>
                {#if import.meta.env.DEV}
                <button class="bg-selected p-1 text-sm font-light rounded-md hover:bg-blue-500 transition-colors float-right" onclick={async () => {
                    loginToSionyw()
                }}>{language.loginSionyw}</button>

                <button class="bg-selected p-1 text-sm font-light rounded-md hover:bg-blue-500 transition-colors float-right" onclick={async () => {
                    testSionywLogin()
                }}>TestSionyw</button>
            {/if}
        {/if}</h1>
    </div>
    {#if DBState.db.account}
        <span class="mb-4 text-textcolor2">ID: {DBState.db.account.id}</span>
        {#if !isTauri}
            <div class="flex items-center mt-2">
                {#if DBState.db.account.useSync || forageStorage.isAccount}
                    <Check check={true} name={language.SaveDataInAccount} onChange={(v) => {
                        if(v){
                            unMigrationAccount()
                        }
                    }}/>
                {:else}
                    <Check check={false} name={language.SaveDataInAccount} onChange={(v) => {
                        if(v){
                            localStorage.setItem('dosync', 'sync')
                            location.reload()
                        }
                    }}/>
                {/if}
            </div>
        {/if}
    {:else}
        <span>{language.notLoggedIn}</span>
        <button class="bg-selected p-2 rounded-md mt-2 hover:bg-blue-500 transition-colors" onclick={() => {
            openIframeURL = hubURL + '/hub/login'
            openIframe = true
        }}>
            Login
        </button>
    {/if}
    <!-- <Button onclick={autoServerBackup}>Auto Server Backups</Button> -->

</div>
<div class="bg-darkbg p-3 rounded-md mb-2 flex flex-col items-start mt-2">
    <h1 class="text-2xl font-black min-w-0 mb-2">{language.cardAttribution}</h1>
    <span class="text-textcolor">{language.cardAttributionName}</span>
    <span class="text-textcolor2 text-xs mb-1">{language.cardAttributionNameDesc}</span>
    <TextInput size="sm" autocomplete="off" fullwidth bind:value={DBState.db.cardAttributionName} />
    {#if attributionIdentity}
        <span class="text-textcolor mt-2">{language.cardAttributionFingerprint}</span>
        <span class="text-textcolor2 font-mono text-sm">{attributionFingerprint(attributionIdentity.id)}</span>
    {/if}
    <div class="flex gap-2 mt-2">
        <Button size="sm" onclick={async () => {
            if(!isValidAttributionSecret(DBState.db.cardAttributionSecret)){
                return
            }
            await navigator.clipboard.writeText(DBState.db.cardAttributionSecret)
            alertNormal(language.cardAttributionKeyCopied)
        }}>{language.cardAttributionCopyKey}</Button>
        <Button size="sm" onclick={async () => {
            const key = (await alertInput(language.cardAttributionRestorePrompt))?.trim().toLowerCase()
            if(!key){
                return
            }
            if(!isValidAttributionSecret(key)){
                alertError(language.cardAttributionInvalidKey)
                return
            }
            if(key === DBState.db.cardAttributionSecret){
                return
            }
            if(await alertConfirm(language.cardAttributionRestoreConfirm)){
                DBState.db.cardAttributionSecret = key
            }
        }}>{language.cardAttributionRestoreKey}</Button>
    </div>
</div>
{#if openIframe}
    <div class="fixed top-0 left-0 bg-black/50 w-full h-full flex justify-center items-center">
        <iframe src={openIframeURL} title="login" class="w-full h-full">
        </iframe>
    </div>
{/if}

<!--

    My song for dear, my old friend.

    Should old aquaintance be forgot,
    and never brought to mind?
    Should old lang syne be forgot,
    and auld lang syne?

    For auld lang syne, my dear,
    for auld lang syne,
    we'll take a cup o' kindness yet,
    for auld lang syne.

-->