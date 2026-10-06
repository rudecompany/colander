<!--
@component The calibration set, labeled blind (seed design section 8): the next source this
reviewer has not labeled, with only what they need to find it on its platform. No verdict, tags or
seed lists. The page around it decides who may label and with what authority: curator authority on
getcolander.com (/console/calibration), the account's full role on the admin host
(/admin/calibration), where staff also get the items whose two labels disagree, for a third.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { LAYER_SIGNALS, PerforatedDisc, PLATFORM_NAME, PlatformTag, platformSourceUrl, SIGNAL_TEXT, SOURCE_NOUN, TESTS, TEST_WORD, type Signal, type Test } from '@colander/shared';
	import { CALIBRATION_LANGUAGES, type CalibrationItem, type CalibrationKind, type CalibrationLabel, type CalibrationLanguage, type Role } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Checkbox from '@colander/shared/components/ui/checkbox/checkbox.svelte';
	import NativeSelect from '@colander/shared/components/ui/native-select/native-select.svelte';
	import RadioGroup from '@colander/shared/components/ui/radio-group/radio-group.svelte';
	import '@colander/shared/components/ui/radio-group/radio-group.css';
	import Textarea from '@colander/shared/components/ui/textarea/textarea.svelte';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ArrowLink from '#lib/components/ArrowLink.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import { api, errorText } from '#lib/api.ts';
	import { siteOrigin } from '#lib/site.ts';

	const LABELS: { value: CalibrationLabel; label: string }[] = [
		{ value: 'slop', label: 'Slop' },
		{ value: 'ai_not_slop', label: 'AI-made, but not slop' },
		{ value: 'not_ai', label: 'Not AI-made' },
		{ value: 'gone', label: 'Gone: the page is not there any more' },
		{ value: 'unsure', label: 'Not sure' }
	];
	const EVIDENCE: Signal[] = LAYER_SIGNALS.provenance;
	// The calibration report groups every judged source by its language and by music or other video,
	// so a list cannot pass on average while it is wrong about one group (seed list review 16).
	const LANGUAGE_NAME: Record<CalibrationLanguage, string> = {
		en: 'English',
		es: 'Spanish',
		pt: 'Portuguese',
		fr: 'French',
		de: 'German',
		it: 'Italian',
		tr: 'Turkish',
		ru: 'Russian',
		ar: 'Arabic',
		hi: 'Hindi',
		id: 'Indonesian',
		ja: 'Japanese',
		ko: 'Korean',
		zh: 'Chinese',
		other: 'Another language',
		none: 'No words, such as instrumental music'
	};
	const LANGUAGES = CALIBRATION_LANGUAGES.map((value) => ({ value, label: LANGUAGE_NAME[value] }));
	const KINDS: { value: CalibrationKind; label: string }[] = [
		{ value: 'music', label: 'Mostly music' },
		{ value: 'video', label: 'Other video' }
	];

	let { authority, name, queueHref }: { authority: Role; name: string | null; queueHref?: string } = $props();
	const AUTHORITY_WORD: Record<Role, string> = { member: 'Member', curator: 'Curator', staff: 'Staff', admin: 'Admin' };

	let item = $state<CalibrationItem | null | undefined>(undefined);
	let loadError = $state('');
	let label = $state<CalibrationLabel | ''>('');
	let tests = $state<Test[]>([]);
	let evidence = $state<Signal[]>([]);
	let note = $state('');
	let language = $state<CalibrationLanguage | ''>('');
	let kind = $state<CalibrationKind | ''>('');
	let saving = $state(false);
	let error = $state('');
	let saved = $state(0);

	const toggle = <T,>(list: T[], v: T, on: boolean): T[] => (on ? [...list, v] : list.filter((x) => x !== v));
	/** A source that is there and that the labeler could judge, as opposed to gone or unsure. */
	const judged = $derived(label !== '' && label !== 'gone' && label !== 'unsure');

	function reset(next: CalibrationItem | null) {
		item = next;
		label = '';
		tests = [];
		evidence = [];
		note = '';
		language = '';
		kind = '';
		error = '';
	}

	async function load() {
		loadError = '';
		item = undefined;
		try {
			reset((await api<{ item: CalibrationItem | null }>('/v1/review/calibration/next')).item);
		} catch (e) {
			loadError = errorText(e);
		}
	}

	onMount(load);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!item || !label) {
			error = 'Choose what you saw first.';
			return;
		}
		if (judged && (!language || !kind)) {
			error = 'Choose its language and whether it is mostly music.';
			return;
		}
		saving = true;
		error = '';
		try {
			const path = `/v1/review/calibration/${item.platform}/${encodeURIComponent(item.source_id)}/label`;
			const res = await api<{ item: CalibrationItem | null }>(path, {
				method: 'POST',
				body: {
					label,
					tests: label === 'slop' ? tests : [],
					evidence: label === 'slop' || label === 'ai_not_slop' ? evidence : [],
					note: note.trim(),
					...(judged ? { language, kind } : {})
				}
			});
			saved++;
			reset(res.item);
		} catch (err) {
			error = errorText(err);
		} finally {
			saving = false;
		}
	}
</script>

<div class="cl-container console-wrap">
	<header class="bar">
		<h1 class="cl-title">Calibration</h1>
		<span class="uin-badge uin-badge-lg">{AUTHORITY_WORD[authority]}{name ? `, ${name}` : ''}</span>
		{#if queueHref}<ArrowLink href={queueHref} size="sm">Review queue</ArrowLink>{/if}
	</header>

	<div class="layout">
		<section class="intro" aria-label="How to label">
			<p class="cl-body-lg">
				Label each source blind. Open it on its platform, judge what you see against the <a href="{siteOrigin(page.url)}/definition">definition</a>, and record
				it here.
			</p>
			<p class="cl-muted">
				You will not see its verdict, its tags or whether a list names it. Two people label each source, and staff settle any
				disagreement. Labels measure how accurate the lists and the thresholds are. They never change a verdict.
			</p>
			{#if saved > 0}<p class="cl-figure cl-muted">{saved} saved this visit</p>{/if}
		</section>

		<div class="work">
			{#if loadError}
				<Notice tone="error" title="The next source could not load"><p>{loadError}</p></Notice>
				<Button variant="secondary" size="md" onclick={load}><RefreshCw size={16} aria-hidden="true" />Try again</Button>
			{:else if item === undefined}
				<Loading />
			{:else if item === null}
				<div class="empty uin-card uin-card-lg uin-card-pad">
					<PerforatedDisc size={96} mark={40} />
					<p class="cl-title">Nothing to label right now.</p>
					<p class="cl-muted">Staff add sources to the calibration set in batches. Check back later.</p>
				</div>
			{:else}
				<form class="uin-card uin-card-lg uin-card-pad form" onsubmit={save} aria-labelledby="item-title">
					<div class="item">
						<p class="cl-eyebrow">{PLATFORM_NAME[item.platform]} {SOURCE_NOUN[item.platform]}</p>
						<h2 class="cl-title id" id="item-title"><PlatformTag platform={item.platform} /> <span>{item.source_id}</span></h2>
						<a class="uin-btn uin-btn-outline uin-btn-lg open" href={platformSourceUrl(item.platform, item.source_id)} rel="noreferrer" target="_blank">
							Open on {PLATFORM_NAME[item.platform]}<ExternalLink size={16} aria-hidden="true" />
						</a>
					</div>

					<fieldset class="group">
						<legend class="field-label">What is it?</legend>
						<div class="labels"><RadioGroup options={LABELS} bind:value={label} ariaLabel="What is it?" /></div>
					</fieldset>

					{#if judged}
						<div class="field">
							<label class="field-label" for="cal-language">Language</label>
							<NativeSelect id="cal-language" size="lg" placeholder="Choose a language" options={LANGUAGES} bind:value={language} />
						</div>
						<fieldset class="group">
							<legend class="field-label">Music or video</legend>
							<div class="labels"><RadioGroup options={KINDS} bind:value={kind} direction="horizontal" ariaLabel="Music or video" /></div>
						</fieldset>
					{/if}
					{#if label === 'slop'}
						<fieldset class="group">
							<legend class="field-label">Tests met</legend>
							{#each TESTS as t (t)}
								<Checkbox label={TEST_WORD[t]} checked={tests.includes(t)} onchange={(e) => (tests = toggle(tests, t, e.currentTarget.checked))} />
							{/each}
						</fieldset>
					{/if}
					{#if label === 'slop' || label === 'ai_not_slop'}
						<fieldset class="group">
							<legend class="field-label">AI evidence you saw on the platform</legend>
							{#each EVIDENCE as s (s)}
								<Checkbox label={SIGNAL_TEXT[s]} checked={evidence.includes(s)} onchange={(e) => (evidence = toggle(evidence, s, e.currentTarget.checked))} />
							{/each}
						</fieldset>
					{/if}

					<div class="field">
						<label class="field-label" for="cal-note">Note, if it helps</label>
						<Textarea id="cal-note" rows={2} maxlength={500} bind:value={note} aria-describedby="cal-note-hint" />
						<p class="field-hint" id="cal-note-hint">Only staff see notes.</p>
					</div>

					{#if error}<p class="field-error" role="alert">{error}</p>{/if}
					<button type="submit" class="uin-btn uin-btn-primary uin-btn-xl" disabled={saving}>{saving ? 'Saving' : 'Save and show the next'}</button>
				</form>
			{/if}
		</div>
	</div>
</div>

<style>
	.console-wrap {
		padding-block: 24px 64px;
	}
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px 12px;
		padding-bottom: 16px;
		margin-bottom: 24px;
		border-bottom: 1px solid var(--cl-border);
	}
	.bar :global(a) {
		margin-left: auto;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 360px) minmax(0, 560px);
		gap: var(--cl-s7);
		align-items: start;
	}
	.intro {
		display: grid;
		gap: var(--cl-s3);
	}
	.work {
		display: grid;
		gap: var(--cl-s3);
		justify-items: start;
	}
	.form {
		display: grid;
		gap: var(--cl-s5);
		width: 100%;
	}
	.item {
		display: grid;
		gap: var(--cl-s2);
		justify-items: start;
	}
	.id {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		overflow-wrap: anywhere;
	}
	.id span {
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.open {
		margin-top: var(--cl-s1);
	}
	.group {
		display: grid;
		gap: var(--cl-s2);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.group legend {
		padding: 0;
	}
	/* Each option is a 32 px target, as every control is. */
	.labels :global(.uin-radio) {
		min-height: 32px;
	}
	.field {
		display: grid;
		gap: var(--cl-s1);
	}
	.empty {
		display: grid;
		justify-items: center;
		gap: var(--cl-s3);
		width: 100%;
		text-align: center;
	}
	@media (max-width: 899px) {
		.layout {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--cl-s5);
		}
	}
	/* A 24-character channel ID stays on one line at phone widths: it is what the labeler reads. */
	@media (max-width: 479px) {
		.id {
			font: var(--cl-body-lg);
			font-weight: 600;
		}
	}
</style>
