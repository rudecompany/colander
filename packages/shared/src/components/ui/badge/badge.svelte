<!--
@component Badge — small label for status / count / tag.

Variants: `neutral` (default), `accent`, `success`, `warn`, `danger`,
`outline`.
Sizes: `sm` (for inline counts inside a button) and `md` (default).

Renders a `<span>`; pass any text/inline content as children.

CSS lives in `./badge.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import {cn} from '../../../utils/cn';

  type Variant = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'outline';
  type Size = 'sm' | 'md';

  type Props = {
    variant?: Variant;
    size?: Size;
    class?: string;
    children: Snippet;
  };

  let {variant = 'neutral', size = 'md', class: className, children}: Props = $props();
</script>

<span class={cn('uin-badge', `uin-badge-${variant}`, `uin-badge-${size}`, className)}>
  {@render children()}
</span>
