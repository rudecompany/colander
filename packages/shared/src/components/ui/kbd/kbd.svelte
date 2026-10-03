<!--
@component Kbd — keyboard shortcut hint.

A `<kbd>` element styled to look like a tactile key cap. Use to
telegraph shortcuts inside menus, search bars (`⌘K`), tooltips, etc.

Pass the literal glyph(s) as children. The component does no
glyph-substitution itself; the macOS conventions (⌘ ⌥ ⇧ ⌃ ↩) and
Windows/Linux conventions (Ctrl, Alt, Shift) are the consumer's call.

CSS lives in `./kbd.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import {cn} from '../../../utils/cn';

  type Props = {
    class?: string;
    children: Snippet;
  };

  let {class: className, children}: Props = $props();
</script>

<kbd class={cn('uin-kbd', className)}>{@render children()}</kbd>
