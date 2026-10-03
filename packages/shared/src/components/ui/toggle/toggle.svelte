<!--
@component Toggle — pressable button with persistent on/off state.

A two-state button — `aria-pressed` flips between `true` and `false`.
Reach for it for *modal state on a single control*: bold/italic toggles
in a text editor, "favorite" star, sidebar visibility.

Use `bind:pressed` for standalone usage. To compose inside ToggleGroup,
pass `pressed={...}` as one-way and react via `onPressedChange`.

Variants: `default` (filled when pressed) and `outline` (bordered).
Sizes: `sm` (24) and `md` (30, default).

CSS lives in `./toggle.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import type {HTMLButtonAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Variant = 'default' | 'outline';
  type Size = 'sm' | 'md';

  type Props = HTMLButtonAttributes & {
    pressed?: boolean;
    onPressedChange?: (next: boolean) => void;
    variant?: Variant;
    size?: Size;
    class?: string;
    children?: Snippet;
  };

  let {
    pressed = $bindable(false),
    onPressedChange,
    variant = 'default',
    size = 'md',
    class: className,
    disabled,
    children,
    type = 'button',
    onclick,
    ...rest
  }: Props = $props();

  function handle(e: MouseEvent & {currentTarget: EventTarget & HTMLButtonElement}) {
    if (disabled) return;
    pressed = !pressed;
    onPressedChange?.(pressed);
    if (typeof onclick === 'function') onclick(e);
  }
</script>

<button
  {type}
  class={cn(
    'uin-toggle',
    `uin-toggle-${variant}`,
    `uin-toggle-${size}`,
    pressed && 'uin-toggle-pressed',
    className
  )}
  aria-pressed={pressed}
  {disabled}
  onclick={handle}
  {...rest}
>
  {#if children}{@render children()}{/if}
</button>
