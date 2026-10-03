<!--
@component List — vertical row list with leading / label / aside slots.

Distinct from `Table`: a List is a vertically-stacked sequence of
single-row entries with a primary label, an optional secondary
description, and optional leading / trailing accessories.

Pass `items: ListItem[]`, or use the children snippet to render
arbitrary row content.

`bordered` adds dividers between rows; `interactive` makes rows
hover/clickable.

CSS lives in `./list.css`.
-->
<script lang="ts">
  import type {Snippet} from 'svelte';
  import {cn} from '../../../utils/cn';

  type ListItem = {
    id?: string;
    label: string;
    description?: string;
    onClick?: () => void;
    disabled?: boolean;
  };

  type Props = {
    items?: ListItem[];
    bordered?: boolean;
    interactive?: boolean;
    class?: string;
    children?: Snippet;
    ariaLabel?: string;
  };

  let {
    items,
    bordered = true,
    interactive = false,
    class: className,
    children,
    ariaLabel,
  }: Props = $props();
</script>

<ul
  class={cn('uin-list', bordered && 'uin-list-bordered', className)}
  aria-label={ariaLabel}
>
  {#if items}
    {#each items as item, i (item.id ?? i)}
      <li class="uin-list-item">
        {#if interactive || item.onClick}
          <button
            type="button"
            class="uin-list-row uin-list-row-interactive"
            disabled={item.disabled}
            onclick={item.onClick}
          >
            <span class="uin-list-label">{item.label}</span>
            {#if item.description}
              <span class="uin-list-desc">{item.description}</span>
            {/if}
          </button>
        {:else}
          <div class="uin-list-row">
            <span class="uin-list-label">{item.label}</span>
            {#if item.description}
              <span class="uin-list-desc">{item.description}</span>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  {/if}
  {#if children}{@render children()}{/if}
</ul>
