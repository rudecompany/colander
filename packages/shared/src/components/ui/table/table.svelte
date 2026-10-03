<!--
@component Table — data-driven HTML table.

Pass `columns: {key, label, align?, width?, sortable?}[]` and
`rows: Record<string, any>[]`. The component renders a styled `<table>`
with sticky header, optional striping, optional row hover, and
client-side sorting when `sortable` is set on a column.

`sort` is bound as `{key, dir: 'asc'|'desc'}`. If you need server-side
sorting, listen to `onSortChange` and skip the `sort` binding.

For richer cell content (chips, avatars, multi-line) reach for the
DataTable component (Wave 5b — coming).

CSS lives in `./table.css`.
-->
<script lang="ts">
  import type {HTMLAttributes} from 'svelte/elements';
  import {cn} from '../../../utils/cn';

  type Align = 'left' | 'center' | 'right';

  type Column = {
    key: string;
    label: string;
    align?: Align;
    width?: string;
    sortable?: boolean;
  };

  type Row = Record<string, unknown>;

  type Sort = {key: string; dir: 'asc' | 'desc'};

  type Props = HTMLAttributes<HTMLTableElement> & {
    columns: Column[];
    rows: Row[];
    sort?: Sort | undefined;
    onSortChange?: (next: Sort | undefined) => void;
    striped?: boolean;
    hoverable?: boolean;
    density?: 'compact' | 'comfortable';
    class?: string;
    emptyLabel?: string;
  };

  let {
    columns,
    rows,
    sort = $bindable<Sort | undefined>(undefined),
    onSortChange,
    striped = false,
    hoverable = true,
    density = 'comfortable',
    class: className,
    emptyLabel = 'No data',
    ...rest
  }: Props = $props();

  const sortedRows = $derived.by(() => {
    const s = sort;
    if (!s) return rows;
    const col = columns.find((c) => c.key === s.key);
    if (!col) return rows;
    const sign = s.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[s.key];
      const bv = b[s.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * sign;
      return String(av).localeCompare(String(bv)) * sign;
    });
  });

  function toggleSort(key: string) {
    let next: Sort | undefined;
    if (!sort || sort.key !== key) next = {key, dir: 'asc'};
    else if (sort.dir === 'asc') next = {key, dir: 'desc'};
    else next = undefined;
    sort = next;
    onSortChange?.(next);
  }
</script>

<div class={cn('uin-table-wrap', striped && 'uin-table-striped', `uin-table-${density}`)}>
  <table class={cn('uin-table', hoverable && 'uin-table-hover', className)} {...rest}>
    <thead>
      <tr>
        {#each columns as col (col.key)}
          <th
            style:width={col.width}
            class:uin-th-right={col.align === 'right'}
            class:uin-th-center={col.align === 'center'}
            class:uin-th-sortable={col.sortable}
            aria-sort={sort?.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
          >
            {#if col.sortable}
              <button type="button" class="uin-th-btn" onclick={() => toggleSort(col.key)}>
                <span>{col.label}</span>
                <span class="uin-th-arrow" aria-hidden="true">
                  {#if sort?.key === col.key}{sort.dir === 'asc' ? '▲' : '▼'}{/if}
                </span>
              </button>
            {:else}
              {col.label}
            {/if}
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#if sortedRows.length === 0}
        <tr><td colspan={columns.length} class="uin-table-empty">{emptyLabel}</td></tr>
      {/if}
      {#each sortedRows as row, i (i)}
        <tr>
          {#each columns as col (col.key)}
            <td
              class:uin-td-right={col.align === 'right'}
              class:uin-td-center={col.align === 'center'}
            >
              {row[col.key] ?? ''}
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
