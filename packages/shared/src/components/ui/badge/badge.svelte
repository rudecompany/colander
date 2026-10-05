<!--
@component Badge: a non-verdict label, such as Default, Recommended, Plus, Your rule, Free,
"14 days free, no card" or Large source. Always an outline pill: never brand-filled, never a
verdict color. 20 tall (`md`, the extension) or 24 (`lg`, the website). Inside `.cl-band` the
outline takes the band's hairline.

`variant` is kept for older callers; every variant renders the same outline.

CSS lives in `./badge.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import {cn} from '../../../utils/cn';

  type Variant = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'outline';
  type Size = 'sm' | 'md' | 'lg';

  type Props = {
    variant?: Variant;
    size?: Size;
    class?: string;
    children: Snippet;
  };

  let {variant = 'outline', size = 'md', class: className, children}: Props = $props();
</script>

<span class={cn('uin-badge', `uin-badge-${variant}`, `uin-badge-${size}`, className)}>
  {@render children()}
</span>
