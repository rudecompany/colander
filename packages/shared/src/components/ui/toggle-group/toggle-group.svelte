<!--
@component ToggleGroup — set of related Toggles bound to one value.

`type="single"` (default) acts as a radio group — one option active at
a time, selecting another swaps. `type="multiple"` acts as a checkbox
set — selections accumulate into an array.

Composes `Toggle` for each option, so visual style follows Toggle's
variant / size.

Bind via `bind:value` — string for single, string[] for multiple.

CSS lives in `./toggle-group.css`.
-->
<script lang="ts" generics="T extends string">
  import type {Snippet} from 'svelte';
  import {cn} from '../../../utils/cn';
  import Toggle from '../toggle/toggle.svelte';

  type Option = {
    value: T;
    label: string;
    icon?: Snippet;
    disabled?: boolean;
  };

  type SelectMode = 'single' | 'multiple';

  type Props = {
    options: Option[];
    type?: SelectMode;
    value?: T | T[];
    onChange?: (next: T | T[]) => void;
    variant?: 'default' | 'outline';
    size?: 'sm' | 'md';
    ariaLabel?: string;
    class?: string;
  };

  let {
    options,
    type = 'single' as SelectMode,
    value = $bindable<T | T[]>(type === 'single' ? ('' as T) : []),
    onChange,
    variant = 'default',
    size = 'md',
    ariaLabel,
    class: className,
  }: Props = $props();

  function isActive(v: T): boolean {
    if (type === 'single') return value === v;
    return Array.isArray(value) && value.includes(v);
  }

  function pick(v: T) {
    if (type === 'single') {
      const next = (value === v ? ('' as T) : v) as T;
      value = next;
      onChange?.(next);
    } else {
      const arr = Array.isArray(value) ? [...value] : [];
      const idx = arr.indexOf(v);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(v);
      value = arr as T[];
      onChange?.(arr);
    }
  }
</script>

<div
  class={cn('uin-toggle-group', className)}
  role={type === 'single' ? 'radiogroup' : 'group'}
  aria-label={ariaLabel}
>
  {#each options as opt (opt.value)}
    {@const active = isActive(opt.value)}
    <Toggle
      pressed={active}
      onPressedChange={() => pick(opt.value)}
      {variant}
      {size}
      disabled={opt.disabled}
    >
      {#if opt.icon}<span class="uin-toggle-group-icon">{@render opt.icon()}</span>{/if}
      {opt.label}
    </Toggle>
  {/each}
</div>
