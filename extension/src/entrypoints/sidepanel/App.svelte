<!--
@component The curator side panel, 360 to 480 wide: the review queue, one source's evidence in one
view, and the decision with a sticky bar. Keys work while the panel has focus and never in a text
field: 1 to 5 and 0 pick a verdict, J and K move through the queue, R goes to the reason, Escape
goes back, Ctrl or Cmd with Enter records, and ? lists them all.
Uses a reviewer token sent by the website's account page through externally_connectable, or pasted here.
-->
<script lang="ts">
	import { ColanderMark, CopyButton, DotMeter, EvidenceCard, LiveBadge, LogRow, PerforatedDisc, PlatformTag, VerdictChip, VerdictGlyph } from '@colander/shared';
	import type { DecisionInput, QueueItem, ReviewSourceResponse } from '@colander/shared/api';
	import { EVIDENCE_TITLE, RESCORE_LINE, TAG_GLYPH } from '@colander/shared/copy';
	import { fmtAgo, fmtNum, fmtPct, fmtShortDate, middleTruncate, platformItemUrl, plural, sourcePath } from '@colander/shared/format';
	import type { Evidence } from '@colander/shared/inpage';
	import { LAYER_KEYS, LAYER_QUESTION, LAYER_SHORT, LAYER_WORD } from '@colander/shared/layers';
	import Badge from '@colander/shared/components/ui/badge/badge.svelte';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import Checkbox from '@colander/shared/components/ui/checkbox/checkbox.svelte';
	import Dialog from '@colander/shared/components/ui/dialog/dialog.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import Kbd from '@colander/shared/components/ui/kbd/kbd.svelte';
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import Switch from '@colander/shared/components/ui/switch/switch.svelte';
	import Tabs from '@colander/shared/components/ui/tabs/tabs.svelte';
	import Textarea from '@colander/shared/components/ui/textarea/textarea.svelte';
	import {
		SIGNAL_TEXT,
		SLOP_TYPES,
		SLOP_TYPE_WORD,
		TAG_WORD,
		TESTS,
		TEST_WORD,
		VERDICT_WORD,
		type Signal,
		type SlopType,
		type TagVerdict,
		type Test,
		type Verdict
	} from '@colander/shared/verdicts';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Keyboard from '@lucide/svelte/icons/keyboard';
	import LogOut from '@lucide/svelte/icons/log-out';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { SITE } from '../../lib/env';
	import { DEFAULT_STATUS, K, type Status } from '../../lib/settings';
	import { ReviewError, review } from '../../ui/review';
	import { stored } from '../../ui/store.svelte';

	type Kind = 'all' | 'reports' | 'appeals' | 'escalations';
	type Choice = Verdict | 'none';

	const token = stored<string | undefined>(K.reviewerToken, undefined);
	const status = stored<Status>(K.status, DEFAULT_STATUS);
	let pasted = $state('');
	let kind = $state<Kind>('all');
	let items = $state<QueueItem[]>([]);
	let cursor = $state<string | null>(null);
	let loading = $state(false);
	let error = $state('');
	let unauthorized = $state(false);
	let open = $state<QueueItem | null>(null);
	let detail = $state<ReviewSourceResponse | null>(null);
	let keys = $state(false);

	// Decision form
	let verdict = $state<Choice>('slop');
	let reason = $state('');
	let signals = $state<Signal[]>([]);
	let slopType = $state<SlopType | null>(null);
	let tests = $state<Test[]>([]);
	let large = $state(false);
	let formError = $state('');
	let saved = $state('');
	let saving = $state(false);
	const reasonEl = () => document.getElementById('reason');

	const KIND_OF: Record<Exclude<Kind, 'all'>, QueueItem['kind']> = { reports: 'report', appeals: 'appeal', escalations: 'escalation' };
	const KIND_WORD = { report: 'Report', appeal: 'Appeal', escalation: 'Escalation' } as const;
	const shown = $derived(kind === 'all' ? items : items.filter((q) => q.kind === KIND_OF[kind as Exclude<Kind, 'all'>]));
	const count = (k: QueueItem['kind']) => items.filter((q) => q.kind === k).length;
	const tabs = $derived([
		{ value: 'all' as Kind, label: 'All', count: items.length },
		{ value: 'reports' as Kind, label: 'Reports', count: count('report') },
		{ value: 'appeals' as Kind, label: 'Appeals', count: count('appeal') },
		{ value: 'escalations' as Kind, label: 'Escalated', count: count('escalation') }
	]);
	const index = $derived(open ? shown.findIndex((q) => q.id === open!.id) : -1);
	const mac = /Mac/.test(navigator.platform);
	const TAGS: TagVerdict[] = ['slop', 'ai_fine', 'not_slop'];
	const CHOICES: { v: Choice; key: string }[] = [
		{ v: 'slop', key: '1' },
		{ v: 'likely_slop', key: '2' },
		{ v: 'ai_made', key: '3' },
		{ v: 'disputed', key: '4' },
		{ v: 'clear', key: '5' },
		{ v: 'none', key: '0' }
	];
	// Reviewers record evidence for the provenance and behavior layers only. Rubric, consensus,
	// staff review and appeal signals are computed by the server, which masks anything else out.
	const RECORDABLE: { name: string; signals: Signal[] }[] = [
		{ name: LAYER_WORD.provenance, signals: ['platform_label', 'content_credentials', 'creator_statement', 'watermark'] },
		{ name: LAYER_WORD.behavior, signals: ['high_volume', 'mostly_ai', 'templated', 'near_duplicates', 'link_funnel', 'cross_posting'] }
	];
	const RECORDABLE_SET = new Set(RECORDABLE.flatMap((g) => g.signals));
	const SHORTCUTS: [string, string][] = [
		['1 to 5', 'Slop, Likely slop, AI-made, Disputed, Clear'],
		['0', 'Not rated'],
		['J', 'Next in the queue'],
		['K', 'Previous in the queue'],
		['R', 'Go to the reason'],
		[mac ? 'Cmd Enter' : 'Ctrl Enter', 'Record decision'],
		['Escape', 'Back to the queue'],
		['?', 'This list']
	];

	function fail(e: unknown) {
		if (e instanceof ReviewError && e.status === 401) unauthorized = true;
		return e instanceof Error ? e.message : String(e);
	}

	async function loadQueue(more = false) {
		if (!token.value) return;
		loading = true;
		error = '';
		try {
			const r = await review.queue(token.value, 'all', more ? cursor : null);
			items = more ? [...items, ...r.items] : r.items;
			cursor = r.next_cursor;
			unauthorized = false;
		} catch (e) {
			error = fail(e);
		}
		loading = false;
	}

	$effect(() => {
		if (token.ready && token.value) void loadQueue();
	});

	async function openItem(q: QueueItem) {
		open = q;
		detail = null;
		error = '';
		saved = '';
		formError = '';
		scrollTo(0, 0);
		try {
			detail = await review.source(token.value!, q.platform, q.source_id);
			const s = detail.source;
			verdict = (q.computed_verdict ?? s.verdict ?? 'slop') as Verdict;
			signals = s.signals.filter((g) => RECORDABLE_SET.has(g));
			slopType = s.slop_type;
			tests = [...s.tests];
			large = s.large;
			reason = '';
		} catch (e) {
			error = fail(e);
		}
	}

	function back() {
		open = null;
		detail = null;
	}

	function step(by: number) {
		const next = shown[index + by];
		if (next) void openItem(next);
	}

	async function decide() {
		if (!open || !detail || saving) return;
		formError = '';
		if (!reason.trim()) {
			formError = 'Write the reason. It is published in the decision log.';
			reasonEl()?.focus();
			return;
		}
		saving = true;
		const body: DecisionInput = { verdict, reason: reason.trim(), signals, slop_type: verdict === 'slop' || verdict === 'likely_slop' ? slopType : null, tests };
		// Only staff may change "large", and the server refuses a curator's decision that carries it
		// at all, so it goes along only when the switch was changed.
		if (large !== detail.source.large) body.large = large;
		try {
			await review.decideSource(token.value!, open.platform, open.source_id, body);
			saved = 'Decision recorded. It reaches every install with the next list update.';
			await loadQueue();
		} catch (e) {
			formError = fail(e);
		}
		saving = false;
	}

	async function dismiss(reportId: string) {
		const why = reason.trim() || 'Reviewed: no change to the verdict.';
		try {
			await review.dismiss(token.value!, reportId, why);
			if (open) await openItem(open);
		} catch (e) {
			formError = fail(e);
		}
	}

	async function appeal(id: string, action: 'verify' | 'upheld' | 'denied') {
		try {
			if (action === 'verify') await review.verifyAppeal(token.value!, id);
			else await review.resolveAppeal(token.value!, id, action, reason.trim() || (action === 'upheld' ? 'Appeal upheld after review.' : 'Appeal denied after review.'));
			if (open) await openItem(open);
		} catch (e) {
			formError = fail(e);
		}
	}

	async function connect(e: Event) {
		e.preventDefault();
		const t = pasted.trim();
		if (!t) return;
		await chrome.storage.local.set({ [K.reviewerToken]: t });
		pasted = '';
		unauthorized = false;
	}

	async function signOut() {
		await chrome.storage.local.remove(K.reviewerToken);
		items = [];
		back();
	}

	const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement | null;
		// The shortcuts dialog handles its own keys.
		if (keys || t?.closest('[role="dialog"]')) return;
		const typing = !!t?.closest('input, textarea, select, [contenteditable="true"]');
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			if (open && detail) {
				e.preventDefault();
				void decide();
			}
			return;
		}
		if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
		if (e.key === '?') {
			e.preventDefault();
			keys = true;
			return;
		}
		if (!open) return;
		const choice = CHOICES.find((c) => c.key === e.key);
		if (choice && detail) {
			e.preventDefault();
			verdict = choice.v;
		} else if (e.key === 'j' || e.key === 'J') step(1);
		else if (e.key === 'k' || e.key === 'K') step(-1);
		else if ((e.key === 'r' || e.key === 'R') && reasonEl()) {
			e.preventDefault();
			reasonEl()!.focus();
		} else if (e.key === 'Escape') back();
	}

	/** The layers that agreed, as the shared evidence card; layers still short of agreement are listed under it. */
	function layerEvidence(d: ReviewSourceResponse): Evidence {
		const sentence = (x: string) => (/[.?]$/.test(x) ? x : `${x}.`);
		return {
			verdict: d.source.verdict,
			word: null,
			title: EVIDENCE_TITLE,
			rows: LAYER_KEYS.map((k) => ({
				key: k,
				label: LAYER_SHORT[k],
				texts: [sentence(d.layers[k].detail), ...d.layers[k].signals.map((g) => sentence(SIGNAL_TEXT[g]))],
				agreed: d.layers[k].met
			})),
			list: null,
			sourceUrl: null,
			appealUrl: null,
			appealText: null
		};
	}
</script>

<!-- Capture phase: the shortcuts dialog closes on Escape in a document listener, which would
     otherwise run first and leave this handler to read the same Escape as Back to the queue. -->
<svelte:window onkeydowncapture={onKey} />

<div class="panel" class:deciding={!!open && !!detail}>
	<header class="head">
		<span class="brand"><ColanderMark size={20} /><h1 class="name">Review queue</h1></span>
		{#if token.value && !unauthorized && items.length}<Badge>{fmtNum(items.length)}</Badge>{/if}
		<span class="live"><LiveBadge sequence={status.value.listSequence || null} updatedAt={status.value.lastSyncAt} /></span>
	</header>

	{#if !token.ready}
		<p class="pad"><span class="three" aria-hidden="true"><i></i><i></i><i></i></span> Loading</p>
	{:else if !token.value || unauthorized}
		<div class="pad">
			<Card title="Review for curators" headingLevel={2}>
				{#if unauthorized}
					<p class="alert" role="alert"><CircleAlert size={16} aria-hidden="true" />Your reviewer token was not accepted. Connect again from your account page.</p>
				{:else}
					<p class="muted">Curators and staff review reports, appeals and escalations here. Open your account on the Colander website and choose Connect side panel, or paste a reviewer token.</p>
				{/if}
				<div class="signin">
					<Button variant="primary" onclick={() => chrome.tabs.create({ url: `${SITE}/account` })}>Open my account</Button>
					<form class="paste" onsubmit={connect}>
						<label for="tok" class="label">Reviewer token</label>
						<div class="row">
							<Input id="tok" type="password" class="grow" bind:value={pasted} autocomplete="off" />
							<Button variant="secondary" type="submit">Connect</Button>
						</div>
					</form>
				</div>
			</Card>
		</div>
	{:else if open}
		<main class="detail">
			<Button variant="quiet" onclick={back}><ChevronLeft size={16} aria-hidden="true" />Queue</Button>
			{#if error}<p class="alert" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>{/if}
			{#if !detail}
				<p class="pad"><span class="three" aria-hidden="true"><i></i><i></i><i></i></span> Loading evidence</p>
			{:else}
				{@const s = detail.source}
				<section class="source" aria-labelledby="src-title">
					<span class="tagline"><PlatformTag platform={s.platform} />{#if s.verdict}<VerdictChip verdict={s.verdict} size="sm" />{:else}<VerdictChip verdict={null} size="sm" />{/if}</span>
					<h2 id="src-title" class="cl-title">{s.name || s.id}</h2>
					<p class="id"><span class="cl-figure" title={s.id}>{middleTruncate(s.id, 24)}</span><CopyButton text={s.id} /></p>
					<p class="flags">
						{#if s.large}<Badge>Large source</Badge>{/if}
						{#if s.imported}<Badge>Imported, not reviewed</Badge>{/if}
						{#if s.appeal_open}<Badge>Appeal open</Badge>{/if}
						{#if open.computed_verdict && open.computed_verdict !== s.verdict}<span class="caption">Scoring says {VERDICT_WORD[open.computed_verdict]}</span>{/if}
					</p>
					{#if s.attribution}<p class="caption">Imported from {s.attribution}</p>{/if}
					<p class="caption">{RESCORE_LINE(s.rescore_at ? fmtShortDate(s.rescore_at) : null)}</p>
					<a class="cl-link" href="{SITE}{sourcePath(s.platform, s.id)}" target="_blank" rel="noopener">Public page<ArrowRight size={16} aria-hidden="true" /></a>
				</section>

				<Card title="Signals" headingLevel={3}>
					<p class="lead">{fmtNum(s.evidence.tags.slop)} tagged Slop, {fmtNum(s.evidence.tags.ai_fine)} AI-made but fine, {fmtNum(s.evidence.tags.not_slop)} Not slop</p>
					<!-- Tag counts in the tag words with their monochrome glyphs: tags are not verdicts. -->
					<ul class="tags" aria-label="Tags">
						{#each TAGS as t (t)}
							<li>
								<Badge><VerdictGlyph verdict={TAG_GLYPH[t]} />{TAG_WORD[t]}</Badge>
								<DotMeter value={s.evidence.tags[t]} max={50 * Math.max(1, Math.ceil(s.evidence.taggers / 50))} />
								<span class="n">{fmtNum(s.evidence.tags[t])}</span>
							</li>
						{/each}
					</ul>
					<p class="caption">Each dot is {plural(Math.max(1, Math.ceil(s.evidence.taggers / 50)), 'tag')}.</p>
					<dl class="facts">
						<div><dt>Taggers</dt><dd>{fmtNum(s.evidence.taggers)}</dd></div>
						<div><dt>AI share</dt><dd>{s.evidence.ai_item_share == null ? 'Not known' : `${fmtPct(s.evidence.ai_item_share)} of ${fmtNum(s.evidence.items_seen)}`}</dd></div>
					</dl>
				</Card>

				<div class="layers">
					<EvidenceCard evidence={layerEvidence(detail)} variant="full" />
					{#if LAYER_KEYS.some((k) => !detail!.layers[k].met)}
						<ul class="unmet" aria-label="Layers not met yet">
							{#each LAYER_KEYS.filter((k) => !detail!.layers[k].met) as k (k)}
								<li><span class="ring" aria-hidden="true"></span><span><b>{LAYER_WORD[k]}</b> <span class="q">{LAYER_QUESTION[k]}</span><br />{detail.layers[k].detail}</span></li>
							{/each}
						</ul>
					{/if}
				</div>

				{#if detail.reports.length}
					<Card title="Reports" headingLevel={3}>
						{#snippet aside()}<Badge>{fmtNum(detail!.reports.length)}</Badge>{/snippet}
						{#each detail.reports as r (r.id)}
							<div class="entry">
								<p>{r.reason}</p>
								<p class="caption">{fmtShortDate(r.created_at)}{r.slop_type ? `, ${SLOP_TYPE_WORD[r.slop_type]}` : ''}{r.tests.length ? `, ${r.tests.map((t) => TEST_WORD[t]).join(', ')}` : ''}</p>
								{#if r.examples.length}<p class="caption">Examples: {r.examples.join(', ')}</p>{/if}
								{#if r.status === 'under_review'}<Button variant="quiet" onclick={() => dismiss(r.id)}>Dismiss with no change</Button>{/if}
							</div>
						{/each}
					</Card>
				{/if}

				{#if detail.appeals.length}
					<Card title="Appeals" headingLevel={3}>
						{#each detail.appeals as a (a.id)}
							<div class="entry">
								<p>{a.statement}</p>
								<p class="caption">{a.status.replace('_', ' ')}, code <span class="cl-figure">{a.code}</span>, {fmtShortDate(a.created_at)}</p>
								<div class="row">
									{#if a.status === 'pending_manual'}<Button variant="secondary" onclick={() => appeal(a.id, 'verify')}>Code is on the account</Button>{/if}
									{#if a.status === 'under_review'}
										<Button variant="secondary" onclick={() => appeal(a.id, 'upheld')}>Uphold</Button>
										<Button variant="secondary" onclick={() => appeal(a.id, 'denied')}>Deny</Button>
									{/if}
								</div>
							</div>
						{/each}
					</Card>
				{/if}

				{#if detail.items.length}
					<Card title="Items" headingLevel={3}>
						<ul class="items">
							{#each detail.items as it (it.id)}
								<li>
									<a class="cl-link cl-figure item" href={platformItemUrl(it.platform, it.id, s.id)} target="_blank" rel="noopener" title={it.id}>{middleTruncate(it.id, 16)}<ArrowRight size={16} aria-hidden="true" /></a>
									<CopyButton text={it.id} />
									{#if it.verdict}<VerdictChip verdict={it.verdict} size="sm" />{/if}
									<span class="caption tags-n">{plural(it.tags.slop, 'Slop tag')}</span>
								</li>
							{/each}
						</ul>
					</Card>
				{/if}

				{#if detail.history.length}
					<Card title="History" headingLevel={3}>
						{#each detail.history.filter((h) => h.from !== h.to) as h (h.id)}<LogRow entry={h} time="date" site={SITE} />{/each}
					</Card>
				{/if}

				<form id="decision" class="decide" onsubmit={(e) => (e.preventDefault(), decide())} aria-labelledby="dec-title">
					<Card>
						<h3 id="dec-title" class="h">Decision</h3>
						<div class="tiles" role="radiogroup" aria-label="Verdict">
							{#each CHOICES as c (c.v)}
								<button
									type="button"
									role="radio"
									class="tile"
									aria-checked={verdict === c.v}
									tabindex={verdict === c.v ? 0 : -1}
									onclick={() => (verdict = c.v)}
									onkeydown={(e) => {
										const i = CHOICES.findIndex((x) => x.v === c.v);
										const n = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
										if (!n) return;
										e.preventDefault();
										verdict = CHOICES[(i + n + CHOICES.length) % CHOICES.length]!.v;
										(e.currentTarget.parentElement?.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
									}}
								>
									<VerdictChip verdict={c.v === 'none' ? null : c.v} />
									<Kbd>{c.key}</Kbd>
								</button>
							{/each}
						</div>
						{#if verdict === 'slop' || verdict === 'likely_slop'}
							<fieldset>
								<legend class="label">Type</legend>
								<SegmentedControl options={SLOP_TYPES.map((t) => ({ value: t, label: SLOP_TYPE_WORD[t] }))} value={slopType as SlopType} onChange={(v: SlopType) => (slopType = v)} ariaLabel="Type" />
							</fieldset>
						{/if}
						<fieldset>
							<legend class="label">Tests</legend>
							<div class="row">{#each TESTS as t (t)}<Checkbox label={TEST_WORD[t]} checked={tests.includes(t)} onchange={() => (tests = toggle(tests, t))} />{/each}</div>
						</fieldset>
						{#each RECORDABLE as group (group.name)}
							<fieldset>
								<legend class="label">{group.name} you checked</legend>
								<div class="checks">
									{#each group.signals as g (g)}<Checkbox label={SIGNAL_TEXT[g]} checked={signals.includes(g)} onchange={() => (signals = toggle(signals, g))} />{/each}
								</div>
							</fieldset>
						{/each}
						<p class="caption">Rubric, consensus, staff review and appeal signals are computed from tags and decisions.</p>
						<label for="reason" class="label">Reason, published in the decision log</label>
						<Textarea id="reason" bind:value={reason} rows={3} maxlength={500} aria-required="true" aria-describedby={formError ? 'form-error' : undefined} />
						<label class="large">
							<span id="large-l" class="label">Large source, staff only</span>
							<Switch checked={large} aria-labelledby="large-l" onCheckedChange={(v) => (large = v)} />
						</label>
						{#if formError}<p class="alert" id="form-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{formError}</p>{/if}
						{#if saved}<p class="saved" role="status">{saved}</p>{/if}
					</Card>
				</form>
				<!-- Sticky at the bottom of the panel for the whole detail view, not only beside the form. -->
				<div class="bar">
					<span class="now">
						<VerdictChip verdict={verdict === 'none' ? null : verdict} size="sm" />
						{#if index >= 0}<span class="cl-figure pos">{index + 1} of {shown.length}</span>{/if}
					</span>
					<!-- Narrow panels keep every key hint: Previous and Next drop their word (below 560 px), and
					     Record decision reads Record (below 440 px), named in full for assistive tech. -->
					<Button variant="secondary" class="step" onclick={() => step(-1)} disabled={index <= 0} aria-label="Previous" aria-keyshortcuts="K"
						><ChevronLeft size={16} aria-hidden="true" /><span class="word">Previous</span><Kbd>K</Kbd></Button
					>
					<Button variant="secondary" class="step" onclick={() => step(1)} disabled={index < 0 || index >= shown.length - 1} aria-label="Next" aria-keyshortcuts="J"
						><span class="word">Next</span><ChevronRight size={16} aria-hidden="true" /><Kbd>J</Kbd></Button
					>
					<Button variant="primary" type="submit" form="decision" loading={saving} aria-label="Record decision" aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}
						><span>Record<span class="rest">{' '}decision</span></span><span class="key" aria-hidden="true"><Kbd>{mac ? '⌘↵' : 'Ctrl ↵'}</Kbd></span></Button
					>
				</div>
			{/if}
		</main>
	{:else}
		<main class="queue">
			<div class="live-narrow"><LiveBadge sequence={status.value.listSequence || null} updatedAt={status.value.lastSyncAt} /></div>
			<Tabs direction="horizontal" ariaLabel="Queue" tabs={tabs} bind:value={kind} />
			{#if error}<p class="alert pad" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>{/if}
			{#if !loading && shown.length === 0 && !error}
				<div class="empty">
					<PerforatedDisc size={64} />
					<p>The queue is empty.</p>
				</div>
			{/if}
			<ul class="list">
				{#each shown as q (q.id)}
					<li>
						<button type="button" class="q" onclick={() => openItem(q)}>
							<span class="l1">
								<PlatformTag platform={q.platform} />
								<span class="kind">{KIND_WORD[q.kind]}</span>
								{#if q.report_count}<span class="caption">{plural(q.report_count, 'report')}</span>{/if}
								{#if q.large}<Badge>Large source</Badge>{/if}
								<span class="cl-figure age">{fmtAgo(q.created_at)}</span>
							</span>
							<span class="l2">
								<span class="src">{q.source_name || q.source_id}</span>
								<VerdictChip verdict={q.verdict} size="sm" />
							</span>
						</button>
					</li>
				{/each}
			</ul>
			<div class="tools">
				{#if cursor}<Button variant="secondary" onclick={() => loadQueue(true)} loading={loading}>Load more</Button>{/if}
				<Button variant="quiet" onclick={() => loadQueue()}><RefreshCw size={16} aria-hidden="true" />Refresh</Button>
				<Button variant="quiet" onclick={() => (keys = true)}><Keyboard size={16} aria-hidden="true" />Shortcuts</Button>
				<Button variant="quiet" onclick={signOut}><LogOut size={16} aria-hidden="true" />Disconnect</Button>
			</div>
		</main>
	{/if}
</div>

<Dialog bind:open={keys} title="Keyboard shortcuts" description="They work while the side panel has focus, and never while you type in a field." size="sm">
	<dl class="keys">
		{#each SHORTCUTS as [k, what] (k)}
			<div><dt><Kbd>{k}</Kbd></dt><dd>{what}</dd></div>
		{/each}
	</dl>
</Dialog>

<style>
	:global(html) {
		scroll-padding-bottom: 80px;
	}
	.panel {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}
	.head {
		position: sticky;
		top: 0;
		z-index: 2;
		display: flex;
		flex: none;
		align-items: center;
		gap: 8px;
		height: 48px;
		padding: 0 12px;
		border-bottom: 1px solid var(--cl-border);
		background: var(--cl-paper);
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	.name {
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.live {
		display: none;
		margin-left: auto;
	}
	.live-narrow {
		padding: 12px 12px 0;
	}
	@media (min-width: 440px) {
		.live {
			display: inline-flex;
		}
		.live-narrow {
			display: none;
		}
	}
	.pad {
		padding: 12px;
	}
	.muted {
		color: var(--cl-text-muted);
	}
	.caption {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.label {
		font: var(--cl-body-strong);
	}
	.alert {
		display: flex;
		align-items: flex-start;
		gap: 6px;
	}
	.alert :global(svg) {
		margin-top: 2px;
	}
	.signin {
		display: grid;
		justify-items: start;
		gap: 16px;
		margin-top: 16px;
	}
	.paste {
		display: grid;
		gap: 4px;
		width: 100%;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.paste .row {
		flex-wrap: nowrap;
	}
	.row :global(.grow) {
		flex: 1;
	}

	/* Queue */
	.queue :global(.uin-tabs) {
		padding: 0 4px;
		border-bottom: 1px solid var(--cl-border);
	}
	.list li {
		border-bottom: 1px solid var(--cl-border);
	}
	.q {
		display: grid;
		align-content: center;
		gap: 4px;
		width: 100%;
		min-height: 64px;
		padding: 8px 12px;
		border: 0;
		background: none;
		color: var(--cl-text);
		text-align: left;
		cursor: pointer;
		transition: background-color var(--cl-fast) var(--cl-ease);
	}
	.q:hover {
		background: var(--cl-surface-raised);
	}
	.q:focus-visible {
		outline: 2px solid var(--cl-brand);
		outline-offset: -2px;
	}
	.l1,
	.l2 {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.kind {
		font: var(--cl-caption);
		font-weight: 600;
	}
	.age {
		margin-left: auto;
		color: var(--cl-text-muted);
	}
	.src {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font: var(--cl-body-strong);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.empty {
		display: grid;
		justify-items: center;
		gap: 12px;
		padding: 48px 16px;
		color: var(--cl-text-muted);
	}
	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 12px 8px;
	}

	/* Detail */
	.detail {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 8px;
		padding: 8px 12px 0;
	}
	.detail > :global(.uin-btn) {
		justify-self: start;
		margin-left: -8px;
	}
	.source {
		display: grid;
		justify-items: start;
		gap: 6px;
		padding: 4px 0 8px;
	}
	.tagline,
	.id,
	.flags {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.flags:empty {
		display: none;
	}
	.lead {
		margin-bottom: 12px;
	}
	/* The dot meters take the room left beside the tag and the count, so the rows fit 360 px. */
	.tags {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr) max-content;
		align-items: center;
		gap: 8px 12px;
	}
	.tags li {
		display: contents;
	}
	.tags :global(.uin-badge) {
		justify-self: start;
		gap: 4px;
	}
	.n {
		font: var(--cl-body-strong);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.tags + .caption {
		margin-top: 8px;
	}
	.facts {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
		margin-top: 16px;
		padding-top: 12px;
		border-top: 1px solid var(--cl-border);
	}
	dt {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	dd {
		font: var(--cl-body-strong);
		font-variant-numeric: tabular-nums;
	}
	.layers {
		display: grid;
		gap: 12px;
		padding: 16px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.layers :global(.cl-pop) {
		padding: 0;
		border: 0;
	}
	.unmet {
		display: grid;
		gap: 8px;
		padding-top: 8px;
		border-top: 2px solid var(--cl-border);
		font: var(--cl-caption);
	}
	.unmet li {
		display: flex;
		gap: 8px;
	}
	.unmet b {
		font: var(--cl-body-strong);
	}
	.unmet .q {
		color: var(--cl-text-muted);
	}
	.ring {
		flex: none;
		width: 6px;
		height: 6px;
		margin-top: 7px;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1.5px var(--cl-text-muted);
	}
	.entry {
		display: grid;
		justify-items: start;
		gap: 4px;
		padding: 12px 0;
		border-top: 1px solid var(--cl-border);
	}
	.entry:first-of-type {
		padding-top: 0;
		border-top: 0;
	}
	.entry :global(.uin-btn-ghost) {
		margin-left: -12px;
	}
	.items li {
		display: flex;
		align-items: center;
		gap: 4px 8px;
		min-height: 40px;
		border-top: 1px solid var(--cl-border);
	}
	.items li:first-child {
		border-top: 0;
	}
	.item {
		min-width: 0;
	}
	.tags-n {
		margin-left: auto;
		white-space: nowrap;
	}
	.decide {
		display: grid;
	}
	.decide > :global(.uin-card) {
		display: grid;
		gap: 12px;
		margin-bottom: 16px;
	}
	/* The same card title as Signals, Items and History: 20/28 is for the source name only. */
	.h {
		font: var(--cl-body-strong);
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}
	.tile {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		height: 40px;
		padding: 0 8px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-chip);
		background: var(--cl-surface);
		cursor: pointer;
	}
	.tile:hover {
		border-color: var(--cl-border-strong);
	}
	.tile[aria-checked='true'] {
		border-color: var(--cl-brand);
		background: var(--cl-brand-tint);
		box-shadow: inset 0 0 0 1px var(--cl-brand);
	}
	.tile:focus-visible {
		outline: 2px solid var(--cl-brand);
		outline-offset: 2px;
	}
	fieldset {
		display: grid;
		gap: 8px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	legend {
		margin-bottom: 8px;
		padding: 0;
	}
	.checks {
		display: grid;
		gap: 4px;
	}
	.large {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-height: 40px;
		cursor: pointer;
	}
	.saved {
		font: var(--cl-body-strong);
	}
	.bar {
		position: sticky;
		bottom: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 64px;
		margin: 0 -12px;
		padding: 0 12px;
		border-top: 1px solid var(--cl-border);
		background: var(--cl-surface);
	}
	.now {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.pos {
		color: var(--cl-text-muted);
		white-space: nowrap;
	}
	.bar :global(.uin-kbd) {
		margin-left: 2px;
	}
	.key {
		display: inline-flex;
	}
	/* The key on the primary button: an outline cap in the button's own text color. */
	.bar :global(.uin-btn-primary .uin-kbd) {
		border-color: color-mix(in srgb, currentColor 55%, transparent);
		background: transparent;
		color: inherit;
	}
	@media (max-width: 559px) {
		.bar {
			gap: 6px;
		}
		.bar :global(.step) {
			gap: 4px;
			padding: 0 8px;
		}
		.word {
			display: none;
		}
	}
	@media (max-width: 439px) {
		.now {
			flex-direction: column;
			align-items: flex-start;
			gap: 2px;
		}
		.rest {
			display: none;
		}
	}
	.keys {
		display: grid;
		gap: 8px;
	}
	.keys div {
		display: grid;
		grid-template-columns: 96px 1fr;
		align-items: center;
		gap: 12px;
	}
</style>
