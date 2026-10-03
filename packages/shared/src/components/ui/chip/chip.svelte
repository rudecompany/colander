<!--
@component Chip — toggleable filter pill.

Sibling to `Badge`, but pressable. Used for filter strips ("EPUB · 12",
"PDF · 4"). When `active`, fills with an accent wash.

If `onClick` is omitted, renders as a non-interactive `<span>`. With
`onClick`, renders a `<button>` and gets hover/focus chrome.

CSS lives in `./chip.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import {cn} from '../../../utils/cn';

  type Props = {
    active?: boolean;
    count?: number;
    onClick?: () => void;
    disabled?: boolean;
    ariaLabel?: string;
    class?: string;
    children: Snippet;
  };

  let {
    active = false,
    count,
    onClick,
    disabled = false,
    ariaLabel,
    class: className,
    children,
  }: Props = $props();

  const interactive = $derived(onClick !== undefined);
</script>

{#if interactive}
  <button
    type="button"
    class={cn('uin-chip', active && 'uin-chip-active', className)}
    onclick={onClick}
    {disabled}
    aria-pressed={active}
    aria-label={ariaLabel}
  >
    <span class="uin-chip-label">{@render children()}</span>
    {#if count !== undefined}
      <span class="uin-chip-count">{count.toLocaleString()}</span>
    {/if}
  </button>
{:else}
  <span class={cn('uin-chip', active && 'uin-chip-active', className)}>
    <span class="uin-chip-label">{@render children()}</span>
    {#if count !== undefined}
      <span class="uin-chip-count">{count.toLocaleString()}</span>
    {/if}
  </span>
{/if}
