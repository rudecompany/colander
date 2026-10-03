<!--
@component NativeSelect — system `<select>` with our chrome.

The browser's native dropdown, styled to match our Input shape. Use it
when the OS-native picker is preferred (mobile drawers, screen-reader
friendliness, server-rendered forms with no JS hydration).

For a popover-style picker with custom chrome, use `Select` instead.

CSS lives in `./native-select.css`.
-->
<script lang="ts" generics="T extends string">
  import type {HTMLSelectAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Option = {
    value: T;
    label: string;
    disabled?: boolean;
  };

  type Props = Omit<HTMLSelectAttributes, 'class' | 'value' | 'size'> & {
    options: Option[];
    value?: T;
    placeholder?: string;
    size?: 'sm' | 'md';
    class?: string;
  };

  let {
    options,
    value = $bindable<T>('' as T),
    placeholder,
    size = 'md',
    class: className,
    disabled,
    ...rest
  }: Props = $props();
</script>

<div
  class={cn('uin-nselect', `uin-nselect-${size}`, disabled && 'uin-nselect-disabled', className)}
>
  <select bind:value class="uin-nselect-el" {disabled} {...rest}>
    {#if placeholder}
      <option value="" disabled selected={!value}>{placeholder}</option>
    {/if}
    {#each options as opt (opt.value)}
      <option value={opt.value} disabled={opt.disabled}>{opt.label}</option>
    {/each}
  </select>
  <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" class="uin-nselect-chev">
    <polyline points="3,5 6,8 9,5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</div>
