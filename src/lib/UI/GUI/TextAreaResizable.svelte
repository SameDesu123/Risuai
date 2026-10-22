<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import { longpress } from 'src/ts/gui/longtouch';

    interface Props {
        value?: string;
        handleLongPress?: any;
    }

  let { value = $bindable(''), handleLongPress = (e:MouseEvent) => {} }: Props = $props();
</script>

<!--
    Auto-grows via a hidden mirror sharing the textarea's grid cell, so the row height follows the content.
    Measuring with JS (height = 0 -> scrollHeight) briefly collapsed the chat scroller and could shift its scroll position.
    `field-sizing: content` could replace the mirror once it is widely available
    (Chrome/Edge 123, Safari 26.2, Firefox 152), but Tauri's macOS/Linux webviews may still lack it.
-->
<div class="grid grid-cols-1 w-full">
    <textarea
        use:longpress={handleLongPress}
        bind:value={value}
        rows="1"
        class="col-start-1 row-start-1 rounded-md p-2 text-textcolor bg-transparent resize-none overflow-y-hidden border border-darkborderc w-full message-edit-area"
        style:font-size="{0.875 * (DBState.db.zoomsize / 100)}rem"
        style:line-height="{(DBState.db.lineHeight ?? 1.25) * (DBState.db.zoomsize / 100)}rem"
    ></textarea>
    <!-- Must match the textarea's typography; pb-6 keeps the old 1rem of slack below the text. The trailing space counts a final empty line. -->
    <div
        aria-hidden="true"
        class="col-start-1 row-start-1 invisible pointer-events-none min-w-0 whitespace-pre-wrap break-words rounded-md p-2 pb-6 border border-transparent"
        style:font-size="{0.875 * (DBState.db.zoomsize / 100)}rem"
        style:line-height="{(DBState.db.lineHeight ?? 1.25) * (DBState.db.zoomsize / 100)}rem"
    >{value + ' '}</div>
</div>
