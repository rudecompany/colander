<!--
@component A recreated results list that applies the real strictness table to six sample items.
Label, collapse and hide behave as they do in the extension, and Show and Why work.
-->
<script lang="ts">
	import {
		ACTION_TABLE,
		ColanderMark,
		SIGNAL_TEXT,
		STRICTNESS,
		STRICTNESS_HINT,
		STRICTNESS_WORD,
		VerdictChip,
		shortReason,
		type Signal,
		type Strictness,
		type Verdict
	} from '@colander/shared';
	import SegmentedControl from '@colander/shared/components/ui/segmented-control/segmented-control.svelte';
	import Eye from '@lucide/svelte/icons/eye';
	import Info from '@lucide/svelte/icons/info';
	import Search from '@lucide/svelte/icons/search';
	import Thumb from './Thumb.svelte';

	type Item = { id: string; title: string; source: string; meta: string; verdict: Verdict | null; signals: Signal[]; art: number };

	const items: Item[] = [
		{ id: 'a', title: 'Restoring a 1962 scooter, part 4: the gearbox', source: 'Workbench Diaries', meta: '18K views, 2 days ago', verdict: null, signals: [], art: 0 },
		{ id: 'b', title: 'The lost city they never told you about', source: 'Ancient Facts Daily', meta: '2.1M views, 6 hours ago', verdict: 'slop', signals: ['platform_label', 'high_volume', 'community_consensus'], art: 1 },
		{ id: 'c', title: 'Watercolor coastline, painted with an AI brush', source: 'Studio Lumen', meta: '42K views, 1 week ago', verdict: 'ai_made', signals: ['creator_statement'], art: 2 },
		{ id: 'd', title: '10 facts about Rome, narrated', source: 'History Bites 24/7', meta: '640K views, 1 day ago', verdict: 'likely_slop', signals: ['templated', 'platform_label', 'rubric_hollow'], art: 3 },
		{ id: 'e', title: 'How tides work, with a bucket and a torch', source: 'Coastal Science Club', meta: '9.4K views, 3 weeks ago', verdict: null, signals: [], art: 4 },
		{ id: 'f', title: 'A dubbed lecture on Byzantine coins', source: 'Numis Notes', meta: '12K views, 4 days ago', verdict: 'disputed', signals: ['open_appeal'], art: 5 }
	];

	let { initial = 'standard' as Strictness, compact = false }: { initial?: Strictness; compact?: boolean } = $props();

	// svelte-ignore state_referenced_locally
	let level = $state<Strictness>(initial);
	let revealed = $state<string[]>([]);
	let why = $state<string | null>(null);

	const action = (it: Item) => (it.verdict ? ACTION_TABLE[level][it.verdict] : 'allow');
	const visible = $derived(items.filter((it) => action(it) !== 'hide'));
	const hidden = $derived(items.length - visible.length);
	const counts = $derived({
		collapsed: items.filter((it) => action(it) === 'collapse').length,
		labeled: items.filter((it) => action(it) === 'label').length
	});

	function setLevel(next: Strictness) {
		level = next;
		revealed = [];
		why = null;
	}
</script>

<div class="demo" class:compact>
	<div class="controls">
		<span class="label" id="demo-strictness">Strictness</span>
		<SegmentedControl
			ariaLabel="Strictness"
			size="sm"
			value={level}
			onChange={setLevel}
			options={STRICTNESS.map((s) => ({ value: s, label: STRICTNESS_WORD[s] }))}
		/>
		<p class="hint"><span>{STRICTNESS_HINT[level]}</span></p>
	</div>

	<div class="frame" role="group" aria-label="Example results list with Colander on {STRICTNESS_WORD[level]}">
		<div class="toolbar">
			<span class="query"><Search size={14} strokeWidth={1.75} aria-hidden="true" /> history documentaries</span>
			<span class="count" title="Hidden on this page">
				<ColanderMark size={18} />
				<span class="badge cl-num" aria-hidden="true">{hidden}</span>
				<span class="sr-only">{hidden} hidden on this page</span>
			</span>
		</div>
		<p class="sr-only" aria-live="polite">
			{STRICTNESS_WORD[level]}: {hidden} hidden, {counts.collapsed} collapsed, {counts.labeled} labeled.
		</p>

		<ul class="list">
			{#each visible as it (it.id)}
				{@const act = action(it)}
				<li>
					{#if act === 'collapse' && !revealed.includes(it.id) && it.verdict}
						<div class="collapsed">
							<VerdictChip verdict={it.verdict} />
							<span class="reason">{shortReason(it.signals)}</span>
							<span class="bar-actions">
								<button type="button" class="quiet" onclick={() => (revealed = [...revealed, it.id])}>
									<Eye size={14} strokeWidth={1.75} aria-hidden="true" /> Show
								</button>
								<button
									type="button"
									class="quiet"
									aria-expanded={why === it.id}
									aria-controls="why-{it.id}"
									onclick={() => (why = why === it.id ? null : it.id)}
								>
									<Info size={14} strokeWidth={1.75} aria-hidden="true" /> Why
								</button>
							</span>
						</div>
						{#if why === it.id}
							<div class="why pop" id="why-{it.id}">
								<p class="why-title">Why this is collapsed</p>
								<ul>
									{#each it.signals.slice(0, 3) as s (s)}<li>{SIGNAL_TEXT[s]}</li>{/each}
								</ul>
								<p class="why-meta">From the core list. Every label links to an appeal.</p>
							</div>
						{/if}
					{:else}
						<div class="card-item">
							<div class="thumb">
								<Thumb art={it.art} />
								{#if it.verdict && (act === 'label' || act === 'collapse')}
									<span class="on-media"><VerdictChip verdict={it.verdict} tone="ink" /></span>
								{/if}
							</div>
							<div class="text">
								<p class="title">{it.title}</p>
								<p class="meta">{it.source}</p>
								<p class="meta">{it.meta}</p>
							</div>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
		{#if hidden > 0}
			<p class="hidden-note">
				{hidden}
				{hidden === 1 ? 'item' : 'items'} hidden for you. The list closes up, and the toolbar counts {hidden === 1 ? 'it' : 'them'}.
			</p>
		{/if}
	</div>
</div>

<style>
	.demo {
		display: grid;
		gap: var(--cl-s4);
	}
	.controls {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: center;
		gap: var(--cl-s2) var(--cl-s3);
	}
	.label {
		font: 600 14px/20px var(--cl-font);
	}
	/* Knock the text out of any dot texture behind the demo. */
	.label,
	.hint span {
		background: var(--cl-paper);
		box-shadow: 0 0 0 4px var(--cl-paper);
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
	}
	.controls :global(.uin-seg) {
		justify-self: start;
	}
	.hint {
		grid-column: 1 / -1;
		font: var(--cl-body);
		color: var(--cl-text-muted);
		min-height: 20px;
	}
	.frame {
		background: var(--cl-surface);
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		overflow: hidden;
	}
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--cl-s3);
		padding: var(--cl-s2) var(--cl-s4);
		border-bottom: 1px solid var(--cl-border);
		background: var(--cl-surface-raised);
	}
	.query {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex: 1;
		max-width: 300px;
		height: 32px;
		padding: 0 var(--cl-s3);
		border-radius: var(--cl-r-full);
		background: var(--cl-surface);
		border: 1px solid var(--cl-border);
		font: var(--cl-body);
		color: var(--cl-text-muted);
		white-space: nowrap;
		overflow: hidden;
	}
	.count {
		position: relative;
		display: inline-flex;
		align-items: center;
		padding: 6px 14px 6px 6px;
		color: var(--cl-text);
	}
	.badge {
		position: absolute;
		right: 0;
		top: 0;
		min-width: 18px;
		height: 18px;
		padding: 0 var(--cl-s1);
		border-radius: var(--cl-r-full);
		background: var(--cl-brand);
		color: var(--cl-brand-fg);
		font: 700 12px/18px var(--cl-font);
		text-align: center;
	}
	.list {
		list-style: none;
		padding: var(--cl-s1) var(--cl-s4);
	}
	.list > li {
		padding-block: 8px;
	}
	.list > li + li {
		border-top: 1px solid color-mix(in srgb, var(--cl-border) 60%, transparent);
	}
	.card-item {
		display: grid;
		grid-template-columns: 136px 1fr;
		gap: var(--cl-s4);
		align-items: start;
	}
	.thumb {
		position: relative;
		aspect-ratio: 16 / 9;
	}
	.on-media {
		position: absolute;
		left: var(--cl-s2);
		top: var(--cl-s2);
	}
	.title {
		font: 600 16px/24px var(--cl-font);
		text-wrap: pretty;
	}
	.meta {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.collapsed {
		display: flex;
		align-items: center;
		gap: var(--cl-s2);
		min-height: 40px;
		padding: var(--cl-s1) var(--cl-s1) var(--cl-s1) var(--cl-s3);
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-chip);
		background: var(--cl-surface-raised);
	}
	.reason {
		font: var(--cl-body);
		color: var(--cl-text-muted);
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.bar-actions {
		display: flex;
		gap: var(--cl-s1);
	}
	.quiet {
		display: inline-flex;
		align-items: center;
		gap: var(--cl-s1);
		height: 32px;
		padding: 0 var(--cl-s2);
		border: 0;
		border-radius: var(--cl-r-chip);
		background: transparent;
		color: var(--cl-brand);
		font: 600 14px/20px var(--cl-font);
		cursor: pointer;
	}
	.quiet:hover {
		background: var(--uin-mat-selected);
	}
	.why {
		margin-top: var(--cl-s2);
		padding: var(--cl-s3) var(--cl-s4);
		font: var(--cl-body);
	}
	.why-title {
		font-weight: 600;
		margin-bottom: var(--cl-s2);
	}
	.why ul {
		padding-left: var(--cl-s4);
		display: grid;
		gap: 2px;
	}
	.why-meta {
		margin-top: 8px;
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.hidden-note {
		border-top: 1px dashed var(--w-control-border);
		margin: 0 var(--cl-s4);
		padding: var(--cl-s3) 0;
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.compact .card-item {
		grid-template-columns: 112px 1fr;
	}
	@media (max-width: 480px) {
		.card-item {
			grid-template-columns: 104px 1fr;
			gap: var(--cl-s3);
		}
		.title {
			font-size: 14px;
			line-height: 20px;
		}
		.collapsed {
			flex-wrap: wrap;
		}
		.reason {
			flex-basis: 40%;
		}
		.query {
			max-width: 220px;
		}
	}
</style>
