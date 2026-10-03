<!--
@component VStack — vertical flex column. Naming-symmetric twin of HStack.

Functionally identical to `Stack`; ships as a separately-forkable
component so codebases that use `HStack` for horizontal layouts can
pair it with `VStack` for vertical without reaching for the
asymmetric "Stack" name. Pick whichever convention reads better in
your code — the kit ships both.

`gap`, `align`, `justify` mirror Stack. Default `gap=2`,
`align='stretch'`, `justify='start'`.

CSS lives in `./vstack.css`.
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
    'uin-vstack',
    `uin-vstack-gap-${gap}`,
    `uin-vstack-align-${align}`,
    `uin-vstack-justify-${justify}`,
    className
  )}
  {...rest}
>
  {#if children}{@render children()}{/if}
</div>
