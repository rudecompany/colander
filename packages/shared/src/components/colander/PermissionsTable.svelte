<!--
@component PermissionsTable: each permission, why Colander asks, and what it never does with it.
A surface card with hairline rows; below 560 px of width the rows become stacked blocks with
"Why:" and "Never:" lines.
-->
<script lang="ts">
	import { PERMISSIONS, PERMISSIONS_HEADINGS } from '../../copy';

	let { caption = 'Permissions Colander asks for' }: { caption?: string } = $props();
</script>

<div class="perms">
	<table>
		<caption class="cl-sr-only">{caption}</caption>
		<thead>
			<tr>
				<th scope="col">{PERMISSIONS_HEADINGS.permission}</th>
				<th scope="col">{PERMISSIONS_HEADINGS.why}</th>
				<th scope="col">{PERMISSIONS_HEADINGS.never}</th>
			</tr>
		</thead>
		<tbody>
			{#each PERMISSIONS as p (p.permission)}
				<tr>
					<th scope="row">{p.permission}</th>
					<td><span class="k" aria-hidden="true">Why: </span>{p.why}</td>
					<td><span class="k" aria-hidden="true">Never: </span>{p.never}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.perms {
		container-type: inline-size;
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
		vertical-align: top;
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
	.k {
		display: none;
		font-weight: 600;
	}
	@container (max-width: 559px) {
		thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
		}
		tr,
		th,
		td {
			display: block;
		}
		tbody tr {
			padding: 12px 16px;
		}
		tbody tr:first-child {
			border-top: 0;
		}
		th,
		td {
			padding: 2px 0;
		}
		.k {
			display: inline;
		}
	}
</style>
