<!--
@component Button — primary action element.

Three visual variants drive the chrome:

- `primary` — filled accent. The "do the thing" button. One per view.
- `ghost` — transparent body, hover-tinted. For toolbars, list rows.
- `outline` — neutral border, used when you want emphasis without color.

Two `size` values: `md` (default, ~30px tall) and `sm` (compact, ~24px,
for inline toolbars).

The `icon` boolean flips the layout to a square hit-target sized for a
single SVG glyph; pair with `aria-label` since there's no text label.

Pass children via the default snippet. Native `button` semantics are
preserved: forward `type`, `disabled`, `aria-*`, and any other native
attribute via `restProps`.

CSS lives in `./button.css`. The CLI copies both files; import the css
file once from your app entry (or pin individual imports in each route
that uses Button).
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLButtonAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Variant = 'primary' | 'ghost' | 'outline';
  type Size = 'sm' | 'md';

  type Props = HTMLButtonAttributes & {
    variant?: Variant;
    size?: Size;
    icon?: boolean;
    class?: string;
    children?: Snippet;
  };

  let {
    variant = 'primary',
    size = 'md',
    icon = false,
    class: className,
    children,
    type = 'button',
    ...rest
  }: Props = $props();
</script>

<button
  {type}
  class={cn('uin-btn', `uin-btn-${variant}`, `uin-btn-${size}`, icon && 'uin-btn-icon', className)}
  {...rest}
>
  {#if children}{@render children()}{/if}
</button>
