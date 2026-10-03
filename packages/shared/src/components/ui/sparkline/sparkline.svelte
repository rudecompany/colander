<!--
@component Sparkline — inline mini line chart.

A tiny SVG line drawn from a `values` array. No axes, labels, or
tooltips — when you need those, reach for the `Chart` component (or
the dedicated `packages/charts`). Sparklines fit inline next to a
metric label or inside a dense table cell.

`values` defines the y-coordinates; the chart auto-scales to min/max.
`area` fills underneath the line for a denser feel. `tone` swaps the
stroke color the same way `Meter` does.

CSS lives in `./sparkline.css`.
-->
<script lang="ts">
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Tone = 'default' | 'success' | 'warn' | 'danger';

  type Props = HTMLAttributes<HTMLSpanElement> & {
    values: number[];
    width?: number;
    height?: number;
    tone?: Tone;
    area?: boolean;
    class?: string;
  };

  let {
    values,
    width = 80,
    height = 24,
    tone = 'default',
    area = false,
    class: className,
    ...rest
  }: Props = $props();

  const path = $derived.by(() => {
    if (!values.length) return {line: '', fill: ''};
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const stepX = values.length > 1 ? width / (values.length - 1) : 0;
    const points = values.map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / span) * height;
      return [x, y] as const;
    });
    const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    const fill = `${line} L${width.toFixed(2)},${height.toFixed(2)} L0,${height.toFixed(2)} Z`;
    return {line, fill};
  });
</script>

<span
  class={cn('uin-spark', `uin-spark-${tone}`, className)}
  aria-hidden="true"
  {...rest}
>
  <svg viewBox="0 0 {width} {height}" {width} {height} preserveAspectRatio="none">
    {#if area}
      <path class="uin-spark-area" d={path.fill} />
    {/if}
    <path class="uin-spark-line" d={path.line} fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</span>
