<!--
@component Stack — vertical flex column with token-driven gap.

The default Wave-1 layout primitive: a `<div>` that lays its children
out in a column, separated by one of the spacing tokens. Use it for
form fields, sidebar lists, card bodies — anywhere you'd otherwise
write `display: flex; flex-direction: column; gap: …` by hand.

`gap` (0–8) maps directly to `0` or `--uin-s-1` … `--uin-s-8`.
Default `2` (8px). `align` and `justify` map to `align-items` / `justify-content`
with the four most common values each.

For a horizontal version use `HStack`; for arbitrary `flex-direction`
+ `flex-wrap` reach for `Flex`.

CSS lives in `./stack.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Gap = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  type Align = 'start' | 'center' | 'end' | 'stretch';
  type Justify = 'start' | 'center' | 'end' | 'between';

  type Props = HTMLAttributes<HTMLDivElement> & {
    gap?: Gap;
    align?: Align;
    justify?: Justify;
    class?: string;
    children?: Snippet;
  };

  let {
    gap = 2,
    align = 'stretch',
    justify = 'start',
    class: className,
    children,
    ...rest
  }: Props = $props();
</script>

<div
  class={cn(
    'uin-stack',
    `uin-stack-gap-${gap}`,
    `uin-stack-align-${align}`,
    `uin-stack-justify-${justify}`,
    className
  )}
  {...rest}
>
  {#if children}{@render children()}{/if}
</div>
