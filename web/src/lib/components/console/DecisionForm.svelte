<!--
@component The review decision form. Shows exactly what will be written to the public log before it posts,
and surfaces curator limits (large sources and open appeals need staff) before submit.
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
	import type { DecisionInput, LogEntry, Role, Source } from '@colander/shared/api';
	import Checkbox from '@colander/shared/components/ui/checkbox/checkbox.svelte';
	import Dialog from '@colander/shared/components/ui/dialog/dialog.svelte';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import Textarea from '@colander/shared/components/ui/textarea/textarea.svelte';
	import Lock from '@lucide/svelte/icons/lock';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { LAYER_KEYS, LAYER_SIGNALS, LAYER_WORD } from '#lib/layers.ts';
	import LogEntryView from '../LogEntryView.svelte';
	import Notice from '../Notice.svelte';

	let {
		source,
		target,
		role,
		displayName,
		onDone,
		onSourceTarget
	}: {
		source: Source;
		target: Target;
		role: Role;
		displayName: string | null;
		onDone: (message: string) => void;
		onSourceTarget: () => void;
	} = $props();

	const REVIEWABLE: Signal[] = LAYER_KEYS.flatMap((k) => LAYER_SIGNALS[k]);

	let verdict = $state<Verdict | 'none' | ''>('');
	let reason = $state('');
	let signals = $state<Signal[]>([]);
	let slopType = $state<SlopType | ''>('');
	let tests = $state<Test[]>([]);
	let large = $state(false);
	let error = $state('');
	let confirming = $state(false);
	let posting = $state(false);
	let staffBlock = $state<string | null>(null);

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
		staffBlock = null;
	});

	const current = $derived(target.kind === 'item' ? target.verdict : source.verdict);
	const slopish = $derived(verdict === 'slop' || verdict === 'likely_slop');
	const needsStaff = $derived(
		role === 'curator' && target.kind === 'source'
			? source.large
				? `${source.name ?? source.id} has a large audience, so only staff can decide it. Leave it in the queue for staff.`
				: source.appeal_open
					? 'An appeal is open on this source, so only staff can decide it until the appeal is resolved.'
					: null
			: null
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
			if (e instanceof ApiError && e.code === 'staff_required') staffBlock = e.message;
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
		<h2 class="t-title" id="decision-title">Decision</h2>
		<p class="t-body muted">
			{#if target.kind === 'item'}
				For item <span class="mono">{target.itemId}</span>.
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

	<fieldset class="group" disabled={!!needsStaff}>
		<legend class="field-label">Verdict</legend>
		<div class="verdicts">
			{#each verdictOptions as o (o.value)}
				<label class="verdict-option" class:on={verdict === o.value}>
					<input type="radio" name="decision-verdict" value={o.value} bind:group={verdict} />
					{#if o.value === 'none'}
						<span class="chip-none">No verdict</span>
					{:else}
						<VerdictChip verdict={o.value} />
					{/if}
					{#if o.value === current}<span class="now">Current</span>{/if}
				</label>
			{/each}
		</div>
	</fieldset>

	<div class="field">
		<label class="field-label" for="decision-reason">Reason</label>
		<Textarea id="decision-reason" rows={4} maxlength={500} bind:value={reason} disabled={!!needsStaff} aria-describedby="reason-hint" />
		<p class="field-hint" id="reason-hint">Published in the decision log. Describe the content and the evidence, never the person.</p>
	</div>

	<fieldset class="group" disabled={!!needsStaff}>
		<legend class="field-label">Signals</legend>
		<div class="signal-groups">
			{#each LAYER_KEYS as k (k)}
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
			<fieldset class="group">
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
				<p class="t-body muted icon-line"><Lock size={14} strokeWidth={1.75} aria-hidden="true" /> Only staff can mark a source as large.</p>
			{/if}
		</div>
	{/if}

	{#if error}<p class="field-error" role="alert">{error}</p>{/if}
	{#if staffBlock}
		<Notice tone="error" title="Staff decision needed"><p>{staffBlock}</p></Notice>
	{/if}

	<button type="submit" class="uin-btn uin-btn-primary btn-lg submit" disabled={!!needsStaff}>Review decision</button>
</form>

<Dialog bind:open={confirming} title="Write this to the public log?" description="Anyone can read this entry. It takes effect at the next list publication, within a minute." size="lg">
	<div class="preview">
		<LogEntryView entry={preview} headingLevel={3} />
	</div>
	{#snippet footer()}
		<button type="button" class="uin-btn uin-btn-ghost uin-btn-md" onclick={() => (confirming = false)}>Go back</button>
		<button type="button" class="uin-btn uin-btn-primary uin-btn-md" onclick={write} disabled={posting}>
			{posting ? 'Writing' : 'Write to the log'}
		</button>
	{/snippet}
</Dialog>

<style>
	.decision {
		display: grid;
		gap: var(--cl-s4);
	}
	.head {
		display: grid;
		gap: 2px;
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
		gap: 6px;
	}
	.verdict-option {
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		padding: 6px 10px;
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
	.now {
		margin-left: auto;
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.signal-groups {
		display: grid;
		gap: var(--cl-s3);
	}
	.signal-group {
		display: grid;
		gap: 6px;
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
