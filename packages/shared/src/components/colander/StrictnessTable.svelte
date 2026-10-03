<!--
@component StrictnessTable: what each level does to each verdict, as icons with words. Standard
carries an outline Default badge; the `current` level's row sits on brand-tint. The same table
on /definition and in options.
-->
<script lang="ts">
	import '../ui/badge/badge.css';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Tag from '@lucide/svelte/icons/tag';
	import VerdictChip from './VerdictChip.svelte';
	import { ACTION_DONE_WORD, ACTION_TABLE, STRICTNESS, STRICTNESS_WORD, VERDICTS, type Strictness } from '../../verdicts';

	let { current, caption = 'What each strictness level does' }: { current?: Strictness; caption?: string } = $props();
	const ICON = { hide: EyeOff, collapse: ChevronsDownUp, label: Tag, allow: Eye };
</script>

<!-- A scrollable region must take focus so keyboards can scroll it (WCAG 2.1.1). -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="wrap" role="region" aria-label={caption} tabindex="0">
	<table>
		<caption class="cl-sr-only">{caption}</caption>
		<thead>
			<tr>
				<th scope="col">Level</th>
				{#each VERDICTS as v (v)}<th scope="col"><VerdictChip verdict={v} size="sm" /></th>{/each}
			</tr>
		</thead>
		<tbody>
			{#each STRICTNESS as level (level)}
				<tr class:current={level === current} aria-current={level === current ? 'true' : undefined}>
					<th scope="row">
						<span class="level">{STRICTNESS_WORD[level]}{#if level === 'standard'}<span class="uin-badge uin-badge-md">Default</span>{/if}</span>
					</th>
					{#each VERDICTS as v (v)}
						{@const a = ACTION_TABLE[level][v]}
						{@const Icon = ICON[a]}
						<td><span class="act"><Icon size={16} aria-hidden="true" />{ACTION_DONE_WORD[a]}</span></td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.wrap {
		overflow-x: auto;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font: var(--cl-body);
	}
	th,
	td {
		padding: 12px 16px;
		text-align: left;
		white-space: nowrap;
	}
	thead th {
		color: var(--cl-text-muted);
		font: var(--cl-chip);
	}
	tbody tr {
		border-top: 1px solid var(--cl-border);
	}
	tbody th {
		font: var(--cl-body-strong);
	}
	.current {
		background: var(--cl-brand-tint);
	}
	.level,
	.act {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.act {
		gap: 6px;
	}
</style>
