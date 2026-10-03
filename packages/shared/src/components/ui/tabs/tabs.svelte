<!--
@component Tabs — pill-style tab strip with optional counts.

Vertical (default) for sidebar sub-navigation; horizontal for top-of-
panel filter strips. Pass `tabs` as `{value, label, count?, disabled?}[]`
and bind `value`.

CSS lives in `./tabs.css`.
-->
<script lang="ts" generics="T extends string">
  import {cn} from '../../../utils/cn';

  type Tab = {
    value: T;
    label: string;
    count?: number;
    disabled?: boolean;
  };

  type Props = {
    tabs: Tab[];
    value: T;
    onChange?: (next: T) => void;
    direction?: 'vertical' | 'horizontal';
    ariaLabel?: string;
    class?: string;
  };

  let {
    tabs,
    value = $bindable(),
    onChange,
    direction = 'vertical',
    ariaLabel,
    class: className,
  }: Props = $props();

  function pick(next: T) {
    if (next === value) return;
    value = next;
    onChange?.(next);
  }
</script>

<div
  class={cn('uin-tabs', `uin-tabs-${direction}`, className)}
  role="tablist"
  aria-label={ariaLabel}
  aria-orientation={direction}
>
  {#each tabs as tab (tab.value)}
    <button
      type="button"
      role="tab"
      class="uin-tab"
      class:uin-tab-active={value === tab.value}
      aria-selected={value === tab.value}
      disabled={tab.disabled || tab.count === 0}
      onclick={() => pick(tab.value)}
    >
      <span>{tab.label}</span>
      {#if tab.count !== undefined}
        <span class="uin-tab-count">{tab.count.toLocaleString()}</span>
      {/if}
    </button>
  {/each}
</div>
