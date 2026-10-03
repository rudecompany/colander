<!--
@component SegmentedControl — radio-group rendered as connected buttons.

Two or more options sharing one rounded rectangle; the active one fills,
the rest are quiet. Use for binary/ternary mode toggles (List/Cards,
Day/Week/Month, Light/Dark/Auto).

Pass `options` as `{value, label, icon?}[]`. Bind `value` to track
selection. Manages `aria-checked` and `role="radiogroup"`/`role="radio"`.

CSS lives in `./segmented-control.css`.
-->
<script lang="ts" generics="T extends string">
  import type {Snippet} from 'svelte';
  import {cn} from '../../../utils/cn';

  type Option = {
    value: T;
    label: string;
    icon?: Snippet;
    disabled?: boolean;
  };

  type Props = {
    options: Option[];
    value: T;
    onChange?: (next: T) => void;
    ariaLabel?: string;
    size?: 'sm' | 'md';
    class?: string;
  };

  let {
    options,
    value = $bindable(),
    onChange,
    ariaLabel,
    size = 'md',
    class: className,
  }: Props = $props();

  function pick(next: T) {
    if (next === value) return;
    value = next;
    onChange?.(next);
  }
</script>

<div
  class={cn('uin-seg', `uin-seg-${size}`, className)}
  role="radiogroup"
  aria-label={ariaLabel}
>
  {#each options as opt (opt.value)}
    <button
      type="button"
      role="radio"
      class="uin-seg-btn"
      class:uin-seg-btn-active={value === opt.value}
      aria-checked={value === opt.value}
      disabled={opt.disabled}
      onclick={() => pick(opt.value)}
    >
      {#if opt.icon}<span class="uin-seg-icon">{@render opt.icon()}</span>{/if}
      <span>{opt.label}</span>
    </button>
  {/each}
</div>
