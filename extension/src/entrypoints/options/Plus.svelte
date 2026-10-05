<!--
@component Plus: one upsell for people without Plus, then keyword and hashtag topics with their own
strictness, and the week in data dots. Gated parts stay in view, inert, at 60% opacity.
-->
<script lang="ts">
	import { PageHeader, PerforatedDisc, PlusTag } from '@colander/shared';
	import { PLAN_COPY } from '@colander/shared/copy';
	import { fmtDay, fmtNum } from '@colander/shared/format';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import Switch from '@colander/shared/components/ui/switch/switch.svelte';
	import { STRICTNESS, STRICTNESS_WORD, type Strictness } from '@colander/shared/verdicts';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Check from '@lucide/svelte/icons/check';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import { SITE } from '../../lib/env';
	import { dayKey, isPlus, K, withDefaults, type Entitlement, type Settings, type Stats, type Topic } from '../../lib/settings';
	import Gated from '../../ui/Gated.svelte';
	import { send, stored } from '../../ui/store.svelte';

	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const entitlement = stored<Entitlement | undefined>(K.entitlement, undefined);
	const stats = stored<Stats | undefined>(K.stats, undefined);
	const settings = $derived(withDefaults(settingsStore.value));
	const plus = $derived(isPlus(entitlement.value));
	const uid = $props.id();

	let busy = $state(false);
	let trialError = $state('');
	async function trial() {
		busy = true;
		trialError = '';
		const r = await send<{ ok: boolean; error?: string }>({ type: 'start-trial' }).catch(() => ({ ok: false, error: 'Could not reach Colander.' }));
		busy = false;
		if (!r.ok) trialError = r.error ?? 'The trial could not start. Try again in a moment.';
	}

	// The week: one column of 10 data dots per day, bottom up.
	const ROWS = 10;
	const week = $derived.by(() => {
		const days = [];
		for (let i = 6; i >= 0; i--) {
			const t = new Date(Date.now() - i * 86_400_000);
			const d = stats.value?.days[dayKey(t.getTime())] ?? { hidden: 0, labeled: 0 };
			// fmtDay reads UTC; the local calendar day goes in as a UTC date.
			const day = fmtDay(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())).split(' ')[0]!;
			days.push({ day, n: d.hidden, labeled: d.labeled });
		}
		return days;
	});
	const peak = $derived(Math.max(0, ...week.map((d) => d.n)));
	const perDot = $derived(Math.max(1, Math.ceil(peak / ROWS)));
	const labeled = $derived(week.reduce((n, d) => n + d.labeled, 0));
	const total = $derived(week.reduce((n, d) => n + d.n, 0));

	// Topics
	let name = $state('');
	let terms = $state('');
	let level = $state<Strictness>('no_ai');
	let hide = $state(false);
	let topicError = $state('');
	const parseTerms = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 50);
	const save = (topics: Topic[]) => void send({ type: 'settings', patch: { topics } });
	function addTopic(e: Event) {
		e.preventDefault();
		topicError = '';
		const list = parseTerms(terms);
		if (!name.trim() || !list.length) {
			topicError = 'Give the topic a name and at least one keyword or #hashtag.';
			return;
		}
		save([...settings.topics, { id: crypto.randomUUID(), name: name.trim().slice(0, 40), terms: list, strictness: level, hide }]);
		name = '';
		terms = '';
		hide = false;
	}
</script>

<PageHeader variant="app" eyebrow="Options" title="Plus" lede="Strictness per topic, keyword and hashtag rules, and a weekly summary. Paying never changes a verdict." />

<div class="cards">
	{#if !plus}
		<Card class="upsell" title={PLAN_COPY.plus.pitch} headingLevel={2}>
			<ul class="checks">
				{#each PLAN_COPY.plus.features as f (f)}<li><Check size={16} aria-hidden="true" />{f}</li>{/each}
			</ul>
			<p class="price"><span class="cl-stat">{PLAN_COPY.plus.price}</span> <span class="alt">{PLAN_COPY.plus.alt}</span></p>
			<div class="btns">
				<Button variant="primary" onclick={trial} loading={busy}>{PLAN_COPY.plus.cta}</Button>
				<Button variant="quiet" href="{SITE}/plans" target="_blank" rel="noopener">Compare plans<ArrowRight size={16} aria-hidden="true" /></Button>
			</div>
			<p class="caption">{PLAN_COPY.plus.trial}. {PLAN_COPY.trust}</p>
			{#if trialError}<p class="err" role="alert"><CircleAlert size={16} aria-hidden="true" />{trialError}</p>{/if}
		</Card>
	{/if}

	<Card title="Topics" headingLevel={2}>
		{#snippet aside()}{#if !plus}<PlusTag />{/if}{/snippet}
		<p class="muted">A topic matches titles and captions by keyword or #hashtag. Matching items use the topic's level when it is stricter. Hide matches hides them even when no list names them.</p>
		<Gated locked={!plus}>
			{#if settings.topics.length === 0}
				<div class="empty">
					<PerforatedDisc size={64} />
					<p>No topics yet. For example: Kids, with #kids and cartoon, at No AI.</p>
				</div>
			{:else}
				<ul class="topics">
					{#each settings.topics as t (t.id)}
						<li>
							<span class="t-name">{t.name}</span>
							<span class="t-terms">{t.terms.join(', ')}</span>
							<span class="uin-badge uin-badge-md">{STRICTNESS_WORD[t.strictness]}</span>
							{#if t.hide}<span class="uin-badge uin-badge-md">Hides matches</span>{/if}
							<Button variant="quiet" aria-label="Delete topic {t.name}" onclick={() => save(settings.topics.filter((x) => x.id !== t.id))}>Delete</Button>
						</li>
					{/each}
				</ul>
			{/if}
			<form class="form" onsubmit={addTopic} aria-label="Add a topic">
				<label class="f"><span>Name</span><Input bind:value={name} maxlength={40} placeholder="Kids" /></label>
				<label class="f grow"><span>Keywords and #hashtags, separated by commas</span><Input bind:value={terms} placeholder="#kids, cartoon, nursery rhymes" /></label>
				<label class="f"><span>Level</span><NativeSelect options={STRICTNESS.map((s) => ({ value: s, label: STRICTNESS_WORD[s] }))} bind:value={level} /></label>
				<div class="form-foot">
					<span class="hide"><Switch bind:checked={hide} aria-labelledby="{uid}-hide" /><span id="{uid}-hide">Hide matches</span></span>
					<Button variant="primary" type="submit">Add topic</Button>
				</div>
				{#if topicError}<p class="err" role="alert"><CircleAlert size={16} aria-hidden="true" />{topicError}</p>{/if}
			</form>
		</Gated>
	</Card>

	<Card title="This week" headingLevel={2}>
		{#snippet aside()}{#if !plus}<PlusTag />{/if}{/snippet}
		<Gated locked={!plus}>
			<p class="sum"><span class="cl-stat">{fmtNum(total)}</span> <span class="muted">hidden in 7 days</span></p>
			<div class="chart">
				<svg
					viewBox="0 0 {7 * 48} {ROWS * 12}"
					width={7 * 48}
					height={ROWS * 12}
					role="img"
					aria-label="Hidden per day: {week.map((d) => `${d.day} ${d.n}`).join(', ')}. Each dot is {perDot} {perDot === 1 ? 'item' : 'items'}."
				>
					{#each week as d, x (x)}
						{#each Array.from({ length: ROWS }, (_, i) => i) as y (y)}
							<circle cx={x * 48 + 24} cy={(ROWS - 1 - y) * 12 + 6} r="3" class:on={y < Math.round(d.n / perDot)} />
						{/each}
					{/each}
				</svg>
				<ol class="days" aria-hidden="true">
					{#each week as d, x (x)}<li><span class="cl-figure">{d.day}</span><span class="n">{fmtNum(d.n)}</span></li>{/each}
				</ol>
			</div>
			<p class="caption">1 dot = {perDot} {perDot === 1 ? 'item' : 'items'}. Also labeled: {fmtNum(labeled)}. Counts stay on this device.</p>
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
	.muted {
		color: var(--cl-text-muted);
	}
	.caption {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.checks {
		display: grid;
		gap: 8px;
	}
	.checks li {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.price {
		display: flex;
		align-items: baseline;
		gap: 8px;
		margin: 16px 0;
	}
	.alt {
		color: var(--cl-text-muted);
	}
	.btns {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 12px;
	}
	.err {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin-top: 8px;
	}
	.err :global(svg) {
		margin-top: 2px;
	}
	.empty {
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 16px 0;
		color: var(--cl-text-muted);
	}
	.topics {
		margin-top: 12px;
		border-top: 1px solid var(--cl-border);
	}
	.topics li {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 48px;
		border-bottom: 1px solid var(--cl-border);
	}
	.t-name {
		font: var(--cl-body-strong);
	}
	.t-terms {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		color: var(--cl-text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.form {
		display: grid;
		grid-template-columns: 160px minmax(0, 1fr) 140px;
		gap: 12px 8px;
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--cl-border);
	}
	/* Under the topic list, its last row's rule is the divider. */
	.topics + .form {
		padding-top: 0;
		border-top: 0;
	}
	.f {
		display: grid;
		align-content: end;
		gap: 4px;
	}
	.f > span {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.form-foot {
		display: flex;
		grid-column: 1 / -1;
		align-items: center;
		justify-content: space-between;
	}
	.form .err {
		grid-column: 1 / -1;
	}
	.hide {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.sum {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	/* 7 columns of 48 px, shrinking together on a narrow screen so the days stay under their dots. */
	.chart {
		display: grid;
		gap: 8px;
		max-width: 336px;
		margin: 16px 0 12px;
	}
	.chart svg {
		width: 100%;
		height: auto;
	}
	circle {
		fill: var(--cl-dot-strong);
	}
	circle.on {
		fill: var(--cl-text);
	}
	.days {
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
		text-align: center;
	}
	.days li {
		display: grid;
	}
	.days .cl-figure {
		color: var(--cl-text-muted);
	}
	.n {
		font: var(--cl-body-strong);
		font-variant-numeric: tabular-nums;
	}
	@media (max-width: 639px) {
		.form {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
