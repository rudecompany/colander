<!--
@component HStack — horizontal flex row with token-driven gap.

Sibling of `Stack`, but `flex-direction: row`. Default `align="center"`
because horizontal layouts almost always want vertical centering of
their items; default `gap=2` matches Stack.

`wrap` lets the row break onto multiple lines when items overflow —
useful for chip rows and tag clouds.

For arbitrary direction + wrap reach for `Flex`.

CSS lives in `./hstack.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Gap = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  type Justify = 'start' | 'center' | 'end' | 'between';

  type Props = HTMLAttributes<HTMLDivElement> & {
    gap?: Gap;
    align?: Align;
    justify?: Justify;
    wrap?: boolean;
    class?: string;
    children?: Snippet;
  };

  let {
    gap = 2,
    align = 'center',
    justify = 'start',
    wrap = false,
    class: className,
    children,
    ...rest
  }: Props = $props();
</script>

<div
  class={cn(
    'uin-hstack',
    `uin-hstack-gap-${gap}`,
    `uin-hstack-align-${align}`,
    `uin-hstack-justify-${justify}`,
    wrap && 'uin-hstack-wrap',
    className
  )}
  {...rest}
>
  {#if children}{@render children()}{/if}
</div>
