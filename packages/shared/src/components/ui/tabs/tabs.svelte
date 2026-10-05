<!--
@component Tabs: a tab strip with optional counts.

`horizontal`: 40 tall, the selected tab in the text color over a 2 px brand underline. Used
for platform tabs, the side panel queue and page filters. `vertical`: 40-tall nav items, the
selected one on brand-tint. Counts follow the label in the figure style ("Reports 7").
Arrow keys, Home and End move between tabs; only the selected tab is a tab stop.

CSS lives in `./tabs.css`.
-->
<script lang="ts" generics="T extends string">
  import {cn} from '../../../utils/cn';
  import {fmtNum} from '../../../utils/format';

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

  function keydown(e: KeyboardEvent) {
    const list = [...((e.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [])];
    const i = list.indexOf(e.currentTarget as HTMLButtonElement);
    const back = direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    const n = list.length;
    const next = e.key === fwd ? (i + 1) % n : e.key === back ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    list[next]!.focus();
    list[next]!.click();
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
      tabindex={value === tab.value ? 0 : -1}
      disabled={tab.disabled}
      onkeydown={keydown}
      onclick={() => pick(tab.value)}
    >
      <span>{tab.label}</span>
      {#if tab.count !== undefined}
        <span class="uin-tab-count">{fmtNum(tab.count)}</span>
      {/if}
    </button>
  {/each}
</div>
