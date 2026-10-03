<!--
@component Card — generic surface.

A panel with the platform's "row" material, a thin border, and an md
radius. The atom most other UI sits on top of when it needs to read as
an enclosed thing.

Variants: `flat` (default) and `tinted` (accent gradient wash).
Padding can be opted out via `padding={false}`.

CSS lives in `./card.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Variant = 'flat' | 'tinted';

  type Props = HTMLAttributes<HTMLDivElement> & {
    variant?: Variant;
    padding?: boolean;
    class?: string;
    children?: Snippet;
  };

  let {
    variant = 'flat',
    padding = true,
    class: className,
    children,
    ...rest
  }: Props = $props();
</script>

<div
  class={cn('uin-card', `uin-card-${variant}`, padding && 'uin-card-pad', className)}
  {...rest}
>
  {#if children}{@render children()}{/if}
</div>
