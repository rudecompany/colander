<!--
@component Skeleton — placeholder block for loading states.

A muted, gently pulsing rectangle that holds layout space while real
content streams in. Use one per discrete piece of pending content
(a heading, a row, an avatar) rather than one giant rectangle.

`variant` picks a default shape: `rect` (default, mass blocks),
`text` (pill, ~12.5px tall, for inline text), `circle` (1:1, for
avatars). Set explicit `width` / `height` for precise sizing.

CSS lives in `./skeleton.css`.
-->
<script lang="ts">
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Variant = 'rect' | 'text' | 'circle';

  type Props = HTMLAttributes<HTMLDivElement> & {
    variant?: Variant;
    width?: string;
    height?: string;
    class?: string;
  };

  let {
    variant = 'rect',
    width,
    height,
    class: className,
    ...rest
  }: Props = $props();

  const sizeStyle = $derived(
    [
      width ? `width: ${width};` : '',
      height ? `height: ${height};` : '',
    ]
      .filter(Boolean)
      .join(' ')
  );
</script>

<div
  class={cn('uin-skeleton', `uin-skeleton-${variant}`, className)}
  style={sizeStyle || undefined}
  aria-busy="true"
  aria-live="polite"
  {...rest}
></div>
