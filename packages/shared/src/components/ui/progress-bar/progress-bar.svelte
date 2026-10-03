<!--
@component ProgressBar — determinate or indeterminate progress.

Determinate mode: pass `value` (0..max). The fill animates between values.
Indeterminate mode: pass `indeterminate={true}`. A short bar slides
across the track on loop.

Sizes: `sm` (2px), `md` (3px, default), `lg` (6px).

CSS lives in `./progress-bar.css`.
-->
<script lang="ts">
  import {cn} from '../../../utils/cn';

  type Props = {
    value?: number;
    max?: number;
    indeterminate?: boolean;
    size?: 'sm' | 'md' | 'lg';
    class?: string;
    label?: string;
  };

  let {
    value = 0,
    max = 1,
    indeterminate = false,
    size = 'md',
    class: className,
    label,
  }: Props = $props();

  const pct = $derived(Math.max(0, Math.min(100, (value / Math.max(0.0001, max)) * 100)));
</script>

<div
  class={cn('uin-progress', `uin-progress-${size}`, indeterminate && 'uin-progress-indeterminate', className)}
  role="progressbar"
  aria-valuemin={0}
  aria-valuemax={indeterminate ? undefined : max}
  aria-valuenow={indeterminate ? undefined : value}
  aria-busy={indeterminate ? 'true' : undefined}
  aria-label={label}
>
  <div class="uin-progress-fill" style={indeterminate ? '' : `width: ${pct}%`}></div>
</div>
