<!--
@component Separator — horizontal or vertical rule.

`orientation="horizontal"` (default) gives a 1px line stretching to
fill its parent's width. `vertical` gives a 1px column that
self-stretches inside a flex/grid row.

`dashed` swaps the solid line for a 1px dashed border — useful as a
quieter divider inside cards.

Renders as `<hr>` for horizontal, `<div role="separator">` for vertical
(since `<hr>` doesn't gracefully accept vertical orientation).

CSS lives in `./separator.css`.
-->
<script lang="ts">
  import {cn} from '../../../utils/cn';

  type Props = {
    orientation?: 'horizontal' | 'vertical';
    dashed?: boolean;
    class?: string;
  };

  let {orientation = 'horizontal', dashed = false, class: className}: Props = $props();
</script>

{#if orientation === 'horizontal'}
  <hr class={cn('uin-sep', 'uin-sep-h', dashed && 'uin-sep-dashed', className)} />
{:else}
  <div
    class={cn('uin-sep', 'uin-sep-v', dashed && 'uin-sep-dashed', className)}
    role="separator"
    aria-orientation="vertical"
  ></div>
{/if}
