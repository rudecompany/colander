<!--
@component Strictness: the three levels as cards with the recreated feed at each level, the table
of what each level does, and per-platform levels for Plus. Label, with every row, sits beside
Standard and No AI, which hide some of them without a gap.
-->
<script lang="ts">
	import { PageHeader, PlatformTag, PlusTag, StrictnessTable } from '@colander/shared';
	import { DEMO_THUMBS_NOTE } from '@colander/shared/copy';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import { PLATFORMS, PLATFORM_NAME, STRICTNESS, STRICTNESS_WORD, type Platform, type Strictness } from '@colander/shared/verdicts';
	import { isPlus, K, withDefaults, type Entitlement, type Settings } from '../../lib/settings';
	import Gated from '../../ui/Gated.svelte';
	import LevelCard from '../../ui/LevelCard.svelte';
	import { send, stored } from '../../ui/store.svelte';

	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	const settings = $derived(withDefaults(settingsStore.value));
	const plus = $derived(isPlus(entitlement.value));
	const uid = $props.id();

	const pick = (level: Strictness) => void send({ type: 'settings', patch: { strictness: level } });

	type PerPlatform = Strictness | 'same';
	const levels = $derived([{ value: 'same' as PerPlatform, label: 'Same' }, ...STRICTNESS.map((l) => ({ value: l as PerPlatform, label: STRICTNESS_WORD[l] }))]);
	function setPlatform(p: Platform, v: PerPlatform) {
		const perPlatform = { ...settings.perPlatform };
		if (v === 'same') delete perPlatform[p];
		else perPlatform[p] = v;
		void send({ type: 'settings', patch: { perPlatform } });
	}
</script>

<PageHeader variant="app" eyebrow="Options" title="Strictness" lede="You decide how strict Colander is. Hidden items leave no gap, and the popup lists each one with Show. Disputed items always show with their mark, and Clear items are always allowed." />

<div class="cards">
	<section aria-labelledby="{uid}-every">
		<h2 id="{uid}-every" class="h">Everywhere</h2>
		<div class="levels" role="radiogroup" aria-labelledby="{uid}-every">
			{#each STRICTNESS as level (level)}
				<LevelCard {level} on={settings.strictness === level} onpick={pick} />
			{/each}
		</div>
		<p class="caption note">{DEMO_THUMBS_NOTE}</p>
	</section>

	<StrictnessTable current={settings.strictness} />

	<Card headingLevel={2} title="Per platform">
		{#snippet aside()}{#if !plus}<PlusTag />{/if}{/snippet}
		<p class="muted">A platform set here uses its own level instead of the one above. Topic rules in Plus can raise it further.</p>
		<Gated locked={!plus}>
			<ul class="rows">
				{#each PLATFORMS as p (p)}
					<li>
						<PlatformTag platform={p} />
						<SegmentedControl
							options={levels}
							value={plus ? (settings.perPlatform[p] ?? 'same') : 'same'}
							onChange={(v) => setPlatform(p, v)}
							ariaLabel="{PLATFORM_NAME[p]} strictness"
						/>
					</li>
				{/each}
			</ul>
			<p class="caption">Same follows the level set everywhere, now {STRICTNESS_WORD[settings.strictness]}.</p>
		</Gated>
	</Card>
</div>

<style>
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		margin-top: 32px;
	}
	.h {
		margin-bottom: 12px;
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.levels {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
	}
	.levels > :global(:first-child) {
		grid-row: span 2;
	}
	.muted {
		margin-bottom: 8px;
		color: var(--cl-text-muted);
	}
	.rows li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		min-height: 48px;
		border-top: 1px solid var(--cl-border);
	}
	.rows :global(.uin-seg) {
		width: 400px;
		max-width: 100%;
	}
	.note {
		margin-top: 12px;
	}
	.caption {
		padding-top: 8px;
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	@media (max-width: 639px) {
		.levels {
			grid-template-columns: minmax(0, 1fr);
		}
		.levels > :global(:first-child) {
			grid-row: auto;
		}
		.rows li {
			flex-direction: column;
			align-items: flex-start;
			padding: 12px 0;
		}
	}
</style>
