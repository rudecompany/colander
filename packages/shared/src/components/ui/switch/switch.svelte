<!--
@component Switch — sliding on/off control (the macOS-Settings shape).

Visually distinct from `Toggle`: instead of a button that fills, this
is a track with a thumb that slides between off (left) and on (right).
Used for *settings* — "Notifications", "Auto-update", "Public profile".

Bind to `checked`. `disabled` greys the whole control.

CSS lives in `./switch.css`.
-->
<script lang="ts">
  import type {HTMLButtonAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Size = 'sm' | 'md';

  type Props = HTMLButtonAttributes & {
    checked?: boolean;
    onCheckedChange?: (next: boolean) => void;
    size?: Size;
    class?: string;
    label?: string;
  };

  let {
    checked = $bindable(false),
    onCheckedChange,
    size = 'md',
    class: className,
    disabled,
    label,
    type = 'button',
    onclick,
    ...rest
  }: Props = $props();

  function handle(e: MouseEvent & {currentTarget: EventTarget & HTMLButtonElement}) {
    if (disabled) return;
    checked = !checked;
    onCheckedChange?.(checked);
    if (typeof onclick === 'function') onclick(e);
  }
</script>

<button
  {type}
  class={cn('uin-switch', `uin-switch-${size}`, checked && 'uin-switch-on', className)}
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={handle}
  {...rest}
>
  <span class="uin-switch-track"></span>
  <span class="uin-switch-thumb"></span>
</button>
