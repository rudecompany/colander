<!--
@component Container — max-width content well with auto margins.

The page-level layout primitive. Centers a column of content inside a
viewport, with a token-driven horizontal padding so text doesn't run
to the edge on narrow screens.

`size` picks one of five max-widths: `sm` (640), `md` (768), `lg`
(1024, default), `xl` (1280), or `full` (no cap, useful for full-bleed
sections that still want the gutter).

CSS lives in `./container.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Size = 'sm' | 'md' | 'lg' | 'xl' | 'full';

  type Props = HTMLAttributes<HTMLDivElement> & {
    size?: Size;
    class?: string;
    children?: Snippet;
  };

  let {size = 'lg', class: className, children, ...rest}: Props = $props();
</script>

<div class={cn('uin-container', `uin-container-${size}`, className)} {...rest}>
  {#if children}{@render children()}{/if}
</div>
