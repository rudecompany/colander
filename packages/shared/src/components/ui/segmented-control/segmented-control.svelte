<!--
@component SegmentedControl — radio-group rendered as connected buttons.

Two or more options sharing one rounded rectangle; the active one fills,
the rest are quiet. Use for binary/ternary mode toggles (List/Cards,
Day/Week/Month, Light/Dark/Auto).

Pass `options` as `{value, label, icon?}[]`. Bind `value` to track
selection. Manages `aria-checked` and `role="radiogroup"`/`role="radio"`,
with the WAI-ARIA radio group keyboard pattern: one tab stop (the checked
option), Left/Up and Right/Down move and check, Home and End jump to the ends.
`radioGroupKeydown` applies the same keys to any other radio group.

CSS lives in `./segmented-control.css`.
-->
<script lang="ts" module>
  const STEP: Record<string, number> = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1};

  /** Keydown handler for each `role="radio"` button inside a `role="radiogroup"`. */
  export function radioGroupKeydown(e: KeyboardEvent) {
    const self = e.currentTarget as HTMLElement;
    const group = self.closest('[role="radiogroup"]');
    const radios = [...(group?.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)') ?? [])];
    const i = radios.indexOf(self);
    if (i < 0) return;
    const n = radios.length;
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : e.key in STEP ? (i + STEP[e.key]! + n) % n : -1;
    if (next < 0) return;
    e.preventDefault();
    radios[next]!.focus();
    radios[next]!.click();
  }
</script>

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

  // The one tab stop: the checked option, or the first enabled one when none is checked.
  const stop = $derived(
    options.some((o) => o.value === value && !o.disabled) ? value : options.find((o) => !o.disabled)?.value,
  );
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
      tabindex={opt.value === stop ? 0 : -1}
      disabled={opt.disabled}
      onkeydown={radioGroupKeydown}
      onclick={() => pick(opt.value)}
    >
      {#if opt.icon}<span class="uin-seg-icon">{@render opt.icon()}</span>{/if}
      <span>{opt.label}</span>
    </button>
  {/each}
</div>
