<!--
@component The review decision form. Shows exactly what will be written to the public log before it posts,
and surfaces the server's limits before submit: curators cannot decide large sources or sources with an
appeal in review (403 staff_required), and Slop or Likely slop needs AI evidence (400 ai_evidence_required).
-->
<script module lang="ts">
	import type { Signal, Verdict } from '@colander/shared';
	export type Target = { kind: 'source' } | { kind: 'item'; itemId: string; verdict: Verdict | null; signals: Signal[] };
</script>

<script lang="ts">
	import {
		SIGNAL_TEXT,
		SLOP_TYPES,
		SLOP_TYPE_WORD,
		TESTS,
		TEST_WORD,
		VerdictChip,
		VERDICTS,
		type SlopType,
		type Test
	} from '@colander/shared';
	import type { Appeal, DecisionInput, LogEntry, ReviewSourceResponse, Role } from '@colander/shared/api';
	import Checkbox from '@colander/shared/components/ui/checkbox/checkbox.svelte';
	import Dialog from '@colander/shared/components/ui/dialog/dialog.svelte';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import Textarea from '@colander/shared/components/ui/textarea/textarea.svelte';
	import Lock from '@lucide/svelte/icons/lock';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { LAYER_KEYS, LAYER_SIGNALS, LAYER_WORD } from '@colander/shared';
	import { LogRow } from '@colander/shared';
	import Notice from '../Notice.svelte';

	let {
		data,
		target,
		role,
		displayName,
		onDone,
		onSourceTarget
	}: {
		data: ReviewSourceResponse;
		target: Target;
		role: Role;
		displayName: string | null;
		onDone: (message: string) => void;
		onSourceTarget: () => void;
	} = $props();

	// Reviewers record provenance and behavior evidence; rubric and consensus signals are computed from tags.
	const RECORDABLE_LAYERS = ['provenance', 'behavior'] as const;
	const REVIEWABLE: Signal[] = RECORDABLE_LAYERS.flatMap((k) => LAYER_SIGNALS[k]);
	// Contract 6.7: appeals in these states lock the source to staff.
	const STAFF_APPEAL: Appeal['status'][] = ['pending_manual', 'under_review'];

	const source = $derived(data.source);

	let verdict = $state<Verdict | 'none' | ''>('');
	let reason = $state('');
	let signals = $state<Signal[]>([]);
	let slopType = $state<SlopType | ''>('');
	let tests = $state<Test[]>([]);
	let large = $state(false);
	let error = $state('');
	let confirming = $state(false);
	let posting = $state(false);
	let refused = $state<{ title: string; message: string } | null>(null);

	// Prefill from whatever is being decided whenever the target changes.
	$effect(() => {
		const fromSignals = target.kind === 'item' ? target.signals : source.signals;
		verdict = '';
		reason = '';
		signals = fromSignals.filter((s) => REVIEWABLE.includes(s));
		slopType = target.kind === 'source' ? (source.slop_type ?? '') : '';
		tests = target.kind === 'source' ? [...source.tests] : [];
		large = source.large;
		error = '';
		refused = null;
	});

	const current = $derived(target.kind === 'item' ? target.verdict : source.verdict);
	const slopish = $derived(verdict === 'slop' || verdict === 'likely_slop');
	const needsStaff = $derived(
		role === 'curator' && target.kind === 'source'
			? source.large
				? `${source.name ?? source.id} has a large audience, so only staff can decide it. Leave it in the queue for staff.`
				: source.appeal_open || data.appeals.some((a) => STAFF_APPEAL.includes(a.status))
					? 'An appeal is open on this source, so only staff can decide it until the appeal is resolved.'
					: null
			: null
	);
	// The form knows the source's layers, not an item's; the server still checks items and answers ai_evidence_required.
	const needsAiEvidence = $derived(
		target.kind === 'source' && !data.layers.provenance.met && !signals.some((s) => LAYER_SIGNALS.provenance.includes(s))
	);

	function toggle<T>(list: T[], value: T, on: boolean): T[] {
		return on ? (list.includes(value) ? list : [...list, value]) : list.filter((v) => v !== value);
	}

	const body = $derived.by((): DecisionInput => {
		const b: DecisionInput = {
			verdict: verdict || 'none',
			reason: reason.trim(),
			signals,
			slop_type: slopish && slopType ? slopType : null,
			tests: slopish ? tests : []
		};
		if (target.kind === 'source' && role === 'staff') b.large = large;
		if (target.kind === 'item') b.source_id = source.id;
		return b;
	});

	const preview = $derived<LogEntry>({
		id: 'preview',
		at: new Date().toISOString(),
		platform: source.platform,
		target_type: target.kind,
		target_id: target.kind === 'item' ? target.itemId : source.id,
		source_id: source.id,
		source_name: source.name,
		from: current,
		to: verdict && verdict !== 'none' ? verdict : null,
		reason: reason.trim(),
		signals,
		actor: role === 'staff' ? 'staff' : 'curator',
		actor_name: displayName
	});

	function review(event: SubmitEvent) {
		event.preventDefault();
		error = '';
		if (!verdict) return (error = 'Choose a verdict, or No verdict.');
		if (reason.trim().length < 10) return (error = 'Write a reason of at least 10 characters. It is published in the log.');
		if (needsStaff) return;
		if (slopish && needsAiEvidence) return (error = 'Slop and Likely slop need AI evidence. Record a provenance signal, or choose another verdict.');
		confirming = true;
	}

	async function write() {
		posting = true;
		const path =
			target.kind === 'item'
				? `/v1/review/items/${source.platform}/${encodeURIComponent(target.itemId)}/decision`
				: `/v1/review/sources/${source.platform}/${encodeURIComponent(source.id)}/decision`;
		try {
			await api(path, { method: 'POST', body });
			confirming = false;
			onDone('Decision written to the public log.');
		} catch (e) {
			confirming = false;
			if (e instanceof ApiError && e.code === 'staff_required') refused = { title: 'Staff decision needed', message: e.message };
			else if (e instanceof ApiError && e.code === 'ai_evidence_required') refused = { title: 'AI evidence needed', message: e.message };
			else error = errorText(e);
		} finally {
			posting = false;
		}
	}

	const verdictOptions: { value: Verdict | 'none'; label: string }[] = [
		...VERDICTS.map((v) => ({ value: v, label: v })),
		{ value: 'none', label: 'none' }
	];
</script>

<form class="decision" onsubmit={review} novalidate aria-labelledby="decision-title">
	<div class="head">
		<h2 class="cl-title" id="decision-title">Decision</h2>
		<p class="cl-body cl-muted">
			{#if target.kind === 'item'}
				For item <span class="cl-figure id">{target.itemId}</span>.
				<button type="button" class="linkish" onclick={onSourceTarget}>Decide the source instead</button>
			{:else}
				For the whole source.
			{/if}
		</p>
	</div>

	{#if needsStaff}
		<Notice title="Staff decision needed">
			<p>{needsStaff}</p>
		</Notice>
	{/if}

	<fieldset class="group" disabled={!!needsStaff} aria-describedby={needsAiEvidence ? 'ai-evidence-hint' : undefined}>
		<legend class="field-label">Verdict</legend>
		<div class="verdicts">
			{#each verdictOptions as o (o.value)}
				{@const locked = needsAiEvidence && (o.value === 'slop' || o.value === 'likely_slop')}
				<label class="verdict-option" class:on={verdict === o.value} class:locked>
					<input type="radio" name="decision-verdict" value={o.value} bind:group={verdict} disabled={locked} />
					{#if o.value === 'none'}
						<span class="uin-badge uin-badge-md">No verdict</span>
					{:else}
						<VerdictChip verdict={o.value} />
					{/if}
					{#if o.value === current}<span class="now">Current</span>{/if}
				</label>
			{/each}
		</div>
		{#if needsAiEvidence}
			<p class="field-hint" id="ai-evidence-hint">
				Slop and Likely slop need AI evidence. The provenance layer is not met, so record a provenance signal below to choose
				them.
			</p>
		{/if}
		<p class="field-hint">Rubric and consensus signals are computed from tags, so they are not set by hand.</p>
	</fieldset>

	<div class="field">
		<label class="field-label" for="decision-reason">Reason</label>
		<Textarea id="decision-reason" rows={4} maxlength={500} bind:value={reason} disabled={!!needsStaff} aria-describedby="reason-hint" />
		<p class="field-hint" id="reason-hint">Published in the decision log. Describe the content and the evidence, never the person.</p>
	</div>

	<fieldset class="group" disabled={!!needsStaff}>
		<legend class="field-label">Signals</legend>
		<div class="signal-groups">
			{#each RECORDABLE_LAYERS as k (k)}
				<div class="signal-group">
					<p class="layer">{LAYER_WORD[k]}</p>
					{#each LAYER_SIGNALS[k] as s (s)}
						<Checkbox
							label={SIGNAL_TEXT[s]}
							checked={signals.includes(s)}
							onchange={(e) => (signals = toggle(signals, s, e.currentTarget.checked))}
						/>
					{/each}
				</div>
			{/each}
		</div>
	</fieldset>

	{#if slopish}
		<div class="row-2">
			<div class="field">
				<label class="field-label" for="decision-type">Type</label>
				<NativeSelect
					id="decision-type"
					value={slopType}
					onchange={(e) => (slopType = e.currentTarget.value as SlopType | '')}
					options={[{ value: '', label: 'No type' }, ...SLOP_TYPES.map((t) => ({ value: t, label: SLOP_TYPE_WORD[t] }))]}
				/>
			</div>
			<fieldset class="group checks">
				<legend class="field-label">Tests met</legend>
				{#each TESTS as t (t)}
					<Checkbox label={TEST_WORD[t]} checked={tests.includes(t)} onchange={(e) => (tests = toggle(tests, t, e.currentTarget.checked))} />
				{/each}
			</fieldset>
		</div>
	{/if}

	{#if target.kind === 'source'}
		<div class="large">
			{#if role === 'staff'}
				<Checkbox label="Large audience. A Slop verdict on it always needs staff." bind:checked={large} />
			{:else}
				<p class="cl-body cl-muted icon-line"><Lock size={16} aria-hidden="true" /> Only staff can mark a source as large.</p>
			{/if}
		</div>
	{/if}

	{#if error}<p class="field-error" role="alert">{error}</p>{/if}
	{#if refused}
		<Notice tone="error" title={refused.title}><p>{refused.message}</p></Notice>
	{/if}

	<button type="submit" class="uin-btn uin-btn-primary uin-btn-xl uin-btn-block submit" disabled={!!needsStaff}>Review decision</button>
</form>

<Dialog bind:open={confirming} title="Write this to the public log?" description="Anyone can read this entry. It takes effect at the next list publication, within a minute." size="lg">
	<div class="preview">
		<LogRow entry={preview} />
	</div>
	{#snippet footer()}
		<button type="button" class="uin-btn uin-btn-ghost uin-btn-xl" onclick={() => (confirming = false)}>Go back</button>
		<button type="button" class="uin-btn uin-btn-primary uin-btn-xl" onclick={write} disabled={posting}>
			{posting ? 'Writing' : 'Write to the log'}
		</button>
	{/snippet}
</Dialog>

<style>
	.id {
		overflow-wrap: anywhere;
	}
	.decision {
		display: grid;
		gap: var(--cl-s4);
	}
	.head {
		display: grid;
		gap: var(--cl-s1);
	}
	.linkish {
		border: 0;
		padding: 0;
		background: none;
		color: var(--cl-brand);
		font: inherit;
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
	}
	.group {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
		display: grid;
		gap: var(--cl-s2);
	}
	.group:disabled {
		opacity: 0.55;
	}
	.verdicts {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--cl-s2);
	}
	.verdict-option {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--cl-s2);
		min-height: 40px;
		padding: var(--cl-s1) var(--cl-s3);
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-chip);
		background: var(--cl-surface);
		cursor: pointer;
	}
	.verdict-option input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}
	.verdict-option:has(input:focus-visible) {
		outline: 2px solid var(--cl-brand);
		outline-offset: 2px;
	}
	.verdict-option.on {
		border-color: var(--cl-brand);
		box-shadow: inset 0 0 0 1px var(--cl-brand);
	}
	.verdict-option.locked {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.now {
		margin-left: auto;
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.signal-groups {
		display: grid;
		gap: var(--cl-s3);
	}
	.signal-group,
	.checks {
		display: grid;
		gap: 0;
	}
	.layer {
		font: 600 12px/16px var(--cl-font);
		color: var(--cl-text-muted);
	}
	.row-2 {
		display: grid;
		gap: var(--cl-s4);
	}
	.large {
		padding-top: var(--cl-s3);
		border-top: 1px solid var(--cl-border);
	}
	.submit {
		width: 100%;
	}
	.preview :global(.entry) {
		grid-template-columns: 1fr;
		padding-block: 0;
	}
	.preview :global(.entry .when) {
		display: flex;
		gap: 8px;
	}
</style>
