<!--
@component Checkbox - boolean form control with optional label.

Native `<input type="checkbox">` wrapped in a styled label. The native
input is visually hidden but remains the source of truth for keyboard
focus, form submission, and accessibility.

Pass `label` for an inline caption next to the box; or wrap children
in your own layout. Bind via `bind:checked`.

`indeterminate` shows a horizontal bar in place of the checkmark for
mixed-state checkboxes (like "select-all" rows).

CSS lives in `./checkbox.css`.
-->
<script lang="ts">
  import type {HTMLInputAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Props = Omit<HTMLInputAttributes, 'type' | 'class' | 'value' | 'size' | 'checked'> & {
    checked?: boolean;
    indeterminate?: boolean;
    label?: string;
    size?: 'sm' | 'md';
    class?: string;
  };

  let {
    checked = $bindable(false),
    indeterminate = false,
    label,
    size = 'md',
    class: className,
    disabled,
    ...rest
  }: Props = $props();

  let el: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (el) el.indeterminate = indeterminate;
  });
</script>

<label class={cn('uin-checkbox', `uin-checkbox-${size}`, disabled && 'uin-checkbox-disabled', className)}>
  <input
    bind:this={el}
    bind:checked
    type="checkbox"
    class="uin-checkbox-input"
    {disabled}
    {...rest}
  />
  <span class="uin-checkbox-box" aria-hidden="true">
    {#if indeterminate}
      <svg viewBox="0 0 16 16" width="10" height="10">
        <line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    {:else}
      <svg viewBox="0 0 16 16" width="10" height="10">
        <polyline points="3,8 7,12 13,4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    {/if}
  </span>
  {#if label}<span class="uin-checkbox-label">{label}</span>{/if}
</label>
