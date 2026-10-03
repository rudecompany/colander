<!-- @component Plus: keyword and hashtag topics with their own strictness, and the weekly summary. -->
<script lang="ts">
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import Sparkline from '@colander/shared/components/ui/sparkline/sparkline.svelte';
	import Switch from '@colander/shared/components/ui/switch/switch.svelte';
	import { STRICTNESS, STRICTNESS_WORD, type Strictness } from '@colander/shared/verdicts';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { dayKey, K, withDefaults, type Entitlement, type Settings, type Stats, type Topic } from '../../lib/settings';
	import Card from '../../ui/Card.svelte';
	import PlusGate from '../../ui/PlusGate.svelte';
	import Section from '../../ui/Section.svelte';
	import { fmtNum, send, stored } from '../../ui/store.svelte';

	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	const stats = stored<Stats | undefined>(K.stats, undefined);
	const settings = $derived(withDefaults(settingsStore.value));
	const plus = $derived(!!entitlement.value?.plus && entitlement.value.exp * 1000 > Date.now());

	const week = $derived.by(() => {
		const days = [];
		for (let i = 6; i >= 0; i--) {
			const t = Date.now() - i * 86_400_000;
			const d = stats.value?.days[dayKey(t)] ?? { hidden: 0, collapsed: 0, labeled: 0 };
			days.push({ label: new Date(t).toLocaleDateString(undefined, { weekday: 'short' }), ...d });
		}
		return days;
	});
	const total = $derived(week.reduce((n, d) => n + d.hidden + d.collapsed, 0));
	const labeled = $derived(week.reduce((n, d) => n + d.labeled, 0));
	const peak = $derived(Math.max(1, ...week.map((d) => d.hidden + d.collapsed)));

	function save(topics: Topic[]) {
		void send({ type: 'settings', patch: { topics } });
	}
	function update(id: string, patch: Partial<Topic>) {
		save(settings.topics.map((t) => (t.id === id ? { ...t, ...patch } : t)));
	}
	function addTopic() {
		save([...settings.topics, { id: crypto.randomUUID(), name: 'New topic', terms: [], strictness: 'strict', hide: false }]);
	}
	const parseTerms = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 50);
</script>

<Section id="plus" title="Plus" description="Strictness per topic, keyword and hashtag rules, and a weekly summary. Paying never changes a verdict.">
	<Card title="Topics">
		{#snippet aside()}
			{#if plus}<Button variant="outline" onclick={addTopic}><Plus size={16} strokeWidth={1.75} />Add topic</Button>{/if}
		{/snippet}
		{#if plus}
			<p class="muted">A topic matches titles and captions by keyword or #hashtag. Matching items use the topic's level when it is stricter. Choose Hide matches to hide them even when no list names them.</p>
			{#if settings.topics.length === 0}
				<p class="muted t-caption">No topics yet. For example: Kids, with #kids and cartoon, at No AI.</p>
			{/if}
			<ul class="topics">
				{#each settings.topics as t (t.id)}
					<li>
						<div class="grid">
							<label for="tn-{t.id}" class="t-caption muted">Name</label>
							<label for="tt-{t.id}" class="t-caption muted">Keywords and #hashtags, separated by commas</label>
							<label for="ts-{t.id}" class="t-caption muted">Level</label>
							<Input id="tn-{t.id}" value={t.name} onchange={(e) => update(t.id, { name: (e.currentTarget as HTMLInputElement).value.slice(0, 40) || 'Topic' })} />
							<Input id="tt-{t.id}" value={t.terms.join(', ')} placeholder="#kids, cartoon, nursery rhymes" onchange={(e) => update(t.id, { terms: parseTerms((e.currentTarget as HTMLInputElement).value) })} />
							<NativeSelect id="ts-{t.id}" options={STRICTNESS.map((s) => ({ value: s, label: STRICTNESS_WORD[s] }))} value={t.strictness} onchange={(e) => update(t.id, { strictness: (e.currentTarget as HTMLSelectElement).value as Strictness })} />
						</div>
						<div class="foot">
							<span class="hide"><Switch checked={t.hide} aria-labelledby="th-{t.id}" onCheckedChange={(v) => update(t.id, { hide: v })} /><span id="th-{t.id}">Hide matches</span></span>
							<Button variant="ghost" class="quiet-muted" aria-label="Delete topic {t.name}" onclick={() => save(settings.topics.filter((x) => x.id !== t.id))}><Trash2 size={16} strokeWidth={1.75} />Delete</Button>
						</div>
					</li>
				{/each}
			</ul>
		{:else}
			<PlusGate what="Give topics their own strictness, like No AI for children's content, and hide anything that matches a keyword or hashtag." />
		{/if}
	</Card>

	<Card title="This week">
		{#if plus}
			<div class="summary">
				<div class="big"><span class="t-display cl-num">{fmtNum(total)}</span><span class="muted">hidden or collapsed in 7 days</span></div>
				<Sparkline values={week.map((d) => d.hidden + d.collapsed)} width={160} height={40} area />
			</div>
			<ol class="bars" aria-label="Hidden or collapsed per day">
				{#each week as d (d.label)}
					<li>
						<span class="bar" style="height: {Math.round(((d.hidden + d.collapsed) / peak) * 64)}px" aria-hidden="true"></span>
						<span class="t-caption muted">{d.label}</span>
						<span class="sr-only">{d.label}: {d.hidden + d.collapsed}</span>
						<span class="t-caption cl-num">{d.hidden + d.collapsed}</span>
					</li>
				{/each}
			</ol>
			<p class="muted t-caption">Also labeled: <span class="cl-num">{fmtNum(labeled)}</span>. Counts stay on this device.</p>
		{:else}
			<PlusGate what="See how much slop Colander kept out of your feeds each week." />
		{/if}
	</Card>
</Section>

<style>
	.topics {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.topics li {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-chip);
	}
	.grid {
		display: grid;
		grid-template-columns: 160px minmax(0, 1fr) 140px;
		gap: 4px 8px;
		align-items: end;
	}
	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.hide {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.summary {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
	}
	.big {
		display: flex;
		flex-direction: column;
	}
	.bars {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 8px;
		align-items: end;
		padding-top: 8px;
		border-top: 1px solid var(--cl-border);
	}
	.bars li {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}
	.bar {
		width: 100%;
		max-width: 40px;
		min-height: 2px;
		border-radius: 4px 4px 0 0;
		background: var(--cl-brand);
	}
</style>
