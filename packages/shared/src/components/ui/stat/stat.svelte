<!--
@component Stat — single label + value pair.

The basic readout for a metric: tiny eyebrow caption above a display-
font number. `accent` swaps the value to the accent color for KPI
emphasis. `size="lg"` enlarges the value (good for dialog summaries).

Pair Stats by wrapping siblings in a `<div class="uin-stat-row">` —
that container is included in `./stat.css` so a row of stats reads as
a single unit.

Optional `hint` snippet renders a small caption beneath the value.

CSS lives in `./stat.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import {cn} from '../../../utils/cn';

  type Tone = 'default' | 'accent';
  type Size = 'sm' | 'md' | 'lg';

  type Props = {
    label: string;
    value: string | number;
    tone?: Tone;
    size?: Size;
    hint?: Snippet;
    class?: string;
  };

  let {label, value, tone = 'default', size = 'md', hint, class: className}: Props = $props();

  const display = $derived(typeof value === 'number' ? value.toLocaleString() : value);
</script>

<div
  class={cn('uin-stat', `uin-stat-${size}`, tone === 'accent' && 'uin-stat-accent', className)}
>
  <span class="uin-stat-label">{label}</span>
  <strong class="uin-stat-value" title={String(value)}>{display}</strong>
  {#if hint}<span class="uin-stat-hint">{@render hint()}</span>{/if}
</div>
