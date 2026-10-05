<!--
@component Card: a surface with a 1 px border and radius 10. Flat: no shadow, ever.

Padding 16 (`size="md"`, the extension) or 24 (`size="lg"`, the website); `padding={false}`
opts out. `title` adds a heading in body 600 (`md`) or title type (`lg`), and `aside` a
right-aligned snippet beside it, such as a quiet button. `interactive` strengthens the border
on hover for a card that is a link or button, with no lift.
`variant="tinted"` uses the raised surface, for the rare nested card.

CSS lives in `./card.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Variant = 'flat' | 'tinted';

  type Props = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
    variant?: Variant;
    size?: 'md' | 'lg';
    padding?: boolean;
    interactive?: boolean;
    title?: string;
    headingLevel?: 2 | 3 | 4;
    aside?: Snippet;
    class?: string;
    children?: Snippet;
  };

  let {
    variant = 'flat',
    size = 'md',
    padding = true,
    interactive = false,
    title,
    headingLevel = 3,
    aside,
    class: className,
    children,
    ...rest
  }: Props = $props();
</script>

<div
  class={cn('uin-card', `uin-card-${variant}`, `uin-card-${size}`, padding && 'uin-card-pad', interactive && 'uin-card-interactive', className)}
  {...rest}
>
  {#if title || aside}
    <div class="uin-card-head">
      {#if title}<svelte:element this={`h${headingLevel}`} class="uin-card-title">{title}</svelte:element>{/if}
      {#if aside}<div class="uin-card-aside">{@render aside()}</div>{/if}
    </div>
  {/if}
  {#if children}{@render children()}{/if}
</div>
