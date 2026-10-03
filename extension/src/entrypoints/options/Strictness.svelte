<!-- @component Strictness: the global level with the spec's table, and per-platform levels for Plus. -->
<script lang="ts">
	import { VerdictChip } from '@colander/shared';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import { ACTION_TABLE, PLATFORMS, PLATFORM_NAME, STRICTNESS, STRICTNESS_HINT, STRICTNESS_WORD, type Platform, type Strictness, type Verdict } from '@colander/shared/verdicts';
	import { K, withDefaults, type Entitlement, type Settings } from '../../lib/settings';
	import Card from '../../ui/Card.svelte';
	import PlusGate from '../../ui/PlusGate.svelte';
	import Section from '../../ui/Section.svelte';
	import { send, stored } from '../../ui/store.svelte';

	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	const settings = $derived(withDefaults(settingsStore.value));
	const plus = $derived(!!entitlement.value?.plus && entitlement.value.exp * 1000 > Date.now());
	const SHOWN: Verdict[] = ['slop', 'likely_slop', 'ai_made'];
	const WORD = { hide: 'Hide', collapse: 'Collapse', label: 'Label', allow: 'Allow' } as const;

	function setPlatform(p: Platform, v: string) {
		const perPlatform = { ...settings.perPlatform };
		if (v === 'same') delete perPlatform[p];
		else perPlatform[p] = v as Strictness;
		void send({ type: 'settings', patch: { perPlatform } });
	}
</script>

<Section id="strictness" title="Strictness" description="You decide how strict Colander is. Disputed items always show with their mark, and Clear items are always allowed.">
	<Card title="Everywhere">
		<SegmentedControl options={STRICTNESS.map((s) => ({ value: s, label: STRICTNESS_WORD[s] }))} value={settings.strictness} onChange={(v) => send({ type: 'settings', patch: { strictness: v } })} ariaLabel="Strictness" />
		<p class="muted">{STRICTNESS_HINT[settings.strictness]}</p>
		<table>
			<caption class="sr-only">What each level does</caption>
			<thead>
				<tr>
					<th scope="col">Level</th>
					{#each SHOWN as v (v)}<th scope="col"><VerdictChip verdict={v} /></th>{/each}
				</tr>
			</thead>
			<tbody>
				{#each STRICTNESS as s (s)}
					<tr class:current={s === settings.strictness}>
						<th scope="row">{STRICTNESS_WORD[s]}{#if s === 'standard'}<span class="def muted t-caption">default</span>{/if}</th>
						{#each SHOWN as v (v)}<td>{WORD[ACTION_TABLE[s][v]]}</td>{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</Card>

	<Card title="Per platform">
		{#if plus}
			<p class="muted">A platform set here uses its own level instead of the one above. Topic rules in Plus can raise it further.</p>
			<ul class="rows">
				{#each PLATFORMS as p (p)}
					<li>
						<label for="lvl-{p}">{PLATFORM_NAME[p]}</label>
						<div class="select">
							<NativeSelect
								id="lvl-{p}"
								options={[{ value: 'same', label: `Same as everywhere (${STRICTNESS_WORD[settings.strictness]})` }, ...STRICTNESS.map((s) => ({ value: s as string, label: STRICTNESS_WORD[s] }))]}
								value={settings.perPlatform[p] ?? 'same'}
								onchange={(e) => setPlatform(p, (e.currentTarget as HTMLSelectElement).value)}
							/>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<PlusGate what="Set a different level for each platform, for example Strict on TikTok and Label on Facebook." />
		{/if}
	</Card>
</Section>

<style>
	table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 4px;
	}
	th,
	td {
		height: 40px;
		padding: 0 12px;
		text-align: left;
		border-top: 1px solid var(--cl-border);
	}
	thead th {
		border-top: 0;
		font-weight: 600;
	}
	tbody th {
		font-weight: 600;
	}
	.def {
		margin-left: 8px;
		font-weight: 400;
	}
	tr.current th,
	tr.current td {
		background: var(--cl-brand-tint);
	}
	tr.current th {
		box-shadow: inset 3px 0 0 var(--cl-brand);
	}
	.rows li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 8px 0;
	}
	.rows li + li {
		border-top: 1px solid var(--cl-border);
	}
	.rows label {
		font-weight: 600;
	}
	.select {
		width: 280px;
	}
</style>
