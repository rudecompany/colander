<!--
@component Spinner — small indeterminate progress indicator.

A single CSS-only ring that rotates. Sizes: `sm` (12px), `md` (16px),
`lg` (24px). Uses `currentColor` for the ring base and `--uin-accent`
for the leading edge so it tints itself to whatever text color it sits
inside.

Use when "something is happening" but you don't have a percentage to
show; reach for `<ProgressBar />` when you do.

CSS lives in `./spinner.css`.
-->
<script lang="ts">
  import {cn} from '../../../utils/cn';

  type Props = {
    size?: 'sm' | 'md' | 'lg';
    class?: string;
    label?: string;
  };

  let {size = 'md', class: className, label = 'Loading'}: Props = $props();
</script>

<span
  class={cn('uin-spinner', `uin-spinner-${size}`, className)}
  role="status"
  aria-label={label}
></span>
