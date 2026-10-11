<script lang="ts">
    import { MenuIcon } from "@lucide/svelte";
    import { popupStore } from "src/ts/stores.svelte";
    import { sleep } from "src/ts/util";
    import { language } from "src/lang";

    const {
        children
    }:{
        children: import("svelte").Snippet
    } = $props();
    
    let buttonId = Math.random()
</script>

<button onclick={async (e:MouseEvent) => {
    await sleep(0)
    if(popupStore.openId === buttonId){
        popupStore.children = null
        popupStore.openId = 0
        return
    }
    popupStore.mouseX = e.clientX
    popupStore.mouseY = e.clientY
    popupStore.children = children
    popupStore.openId = buttonId
}} class="hover:text-blue-500 transition-colors button-icon-menu" aria-label={language.menu} aria-haspopup="menu">
    <MenuIcon size={20} aria-hidden="true" />
</button>