<!--
@component Section — semantic `<section>` with optional title + subtitle.

The page-region wrapper. Use it to break long pages into discoverable
chunks: the heading is rendered with the display font, the subtitle
in muted body. Pass `title` to render a default header, or omit it
and provide your own structure inside `children`.

`level` picks h2 (default), h3, or h4 for the heading element so the
outline depth matches the page.

CSS lives in `./section.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Props = HTMLAttributes<HTMLElement> & {
    title?: string;
    subtitle?: string;
    level?: 2 | 3 | 4;
    class?: string;
    children?: Snippet;
  };

  let {
    title,
    subtitle,
    level = 2,
    class: className,
    children,
    ...rest
  }: Props = $props();
</script>

<section class={cn('uin-section', className)} {...rest}>
  {#if title}
    <header class="uin-section-head">
      <svelte:element this={`h${level}`} class="uin-section-title">{title}</svelte:element>
      {#if subtitle}<p class="uin-section-sub">{subtitle}</p>{/if}
    </header>
  {/if}
  {#if children}{@render children()}{/if}
</section>
