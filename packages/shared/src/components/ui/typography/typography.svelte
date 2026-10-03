<!--
@component Typography — preset typographic styles with optional element override.

A single component that renders one of nine typographic presets with
the right token-driven styling for our voice:

| Variant   | Default tag | Family     | Notes                              |
| --------- | ----------- | ---------- | ---------------------------------- |
| display   | h1          | display    | Page hero (clamp 28→38px)          |
| h1        | h1          | display    | 28px                               |
| h2        | h2          | display    | 20px                               |
| h3        | h3          | display    | 17px                               |
| h4        | h4          | UI         | 14px, 600 weight                   |
| lead      | p           | UI         | 14.5px regular intro               |
| body      | p           | UI         | 13px regular default               |
| caption   | p           | UI         | 12px muted                         |
| eyebrow   | p           | UI         | 10.5px uppercase tracked           |

`tone` swaps text color (`default` / `muted` / `dim`). `as` lets you
render the visual style on a different HTML element when the document
outline calls for it (e.g. an h2-styled `<h3>`).

CSS lives in `./typography.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Variant =
    | 'display'
    | 'h1'
    | 'h2'
    | 'h3'
    | 'h4'
    | 'lead'
    | 'body'
    | 'caption'
    | 'eyebrow';

  type Tone = 'default' | 'muted' | 'dim';

  type AsTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'span' | 'div';

  type Props = HTMLAttributes<HTMLElement> & {
    variant?: Variant;
    tone?: Tone;
    as?: AsTag;
    class?: string;
    children?: Snippet;
  };

  const defaultTag: Record<Variant, AsTag> = {
    display: 'h1',
    h1: 'h1',
    h2: 'h2',
    h3: 'h3',
    h4: 'h4',
    lead: 'p',
    body: 'p',
    caption: 'p',
    eyebrow: 'p',
  };

  let {
    variant = 'body',
    tone = 'default',
    as,
    class: className,
    children,
    ...rest
  }: Props = $props();

  const tag = $derived(as ?? defaultTag[variant]);
</script>

<svelte:element
  this={tag}
  class={cn('uin-type', `uin-type-${variant}`, `uin-type-tone-${tone}`, className)}
  {...rest}
>
  {#if children}{@render children()}{/if}
</svelte:element>
