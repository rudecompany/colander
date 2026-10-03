<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { PLATFORM_NAME, SOURCE_NOUN, type Platform } from '@colander/shared';
	import type { Appeal, SourceResponse } from '@colander/shared/api';
	import Scale from '@lucide/svelte/icons/scale';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import Textarea from '@colander/shared/components/ui/textarea/textarea.svelte';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import { canAppeal, sourcePath } from '#lib/format.ts';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';
	import VerdictOrNone from '#lib/components/VerdictOrNone.svelte';

	const platform = $derived(page.params.platform as Platform);
	const id = $derived(page.params.id ?? '');
	const noun = $derived(SOURCE_NOUN[platform]);

	let source = $state<{ kind: 'loading' } | { kind: 'ok'; data: SourceResponse } | { kind: 'not_rated' } | { kind: 'error'; message: string }>({
		kind: 'loading'
	});
	let email = $state('');
	let statement = $state('');
	let sending = $state(false);
	let formError = $state('');

	$effect(() => {
		const p = platform;
		const sid = id;
		source = { kind: 'loading' };
		api<SourceResponse>(`/v1/sources/${p}/${encodeURIComponent(sid)}`).then(
			(data) => (source = { kind: 'ok', data }),
			(e) => (source = e instanceof ApiError && e.status === 404 ? { kind: 'not_rated' } : { kind: 'error', message: errorText(e) })
		);
	});

	const s = $derived(source.kind === 'ok' ? source.data.source : null);
	const name = $derived(s?.name ?? id);
	const appealable = $derived(canAppeal(s));

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		formError = '';
		if (!email.includes('@')) return (formError = 'Enter the email address where we should send the appeal link.');
		if (statement.trim().length < 20) return (formError = 'Tell us a little more, in at least 20 characters.');
		sending = true;
		try {
			const res = await api<{ appeal: Appeal; secret: string }>('/v1/appeals', {
				method: 'POST',
				body: { platform, source_id: s?.id ?? id, email: email.trim(), statement: statement.trim() }
			});
			await goto(`/appeal/status/${encodeURIComponent(res.appeal.id)}?secret=${encodeURIComponent(res.secret)}`);
		} catch (e) {
			formError = errorText(e);
		} finally {
			sending = false;
		}
	}
</script>

<svelte:head>
	<title>Appeal the verdict for {name} · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap wrap-narrow page">
	<p><a class="back icon-line" href={sourcePath(platform, id)}><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" /> Back to the source page</a></p>
	<header class="head">
		<p class="eyebrow">Appeal</p>
		<h1 class="t-display">Appeal the verdict for {name}</h1>
		<p class="t-lede">
			If this {PLATFORM_NAME[platform]} {noun} is yours and the verdict is wrong, tell us why. You prove the {noun} is yours
			with a short code, and nothing from it is hidden while staff review.
		</p>
	</header>

	{#if source.kind === 'loading'}
		<Loading />
	{:else if source.kind === 'error'}
		<Notice tone="error" title="This page could not load"><p>{source.message}</p></Notice>
	{:else if !s || !s.verdict}
		<Notice title="There is nothing to appeal">
			<p>Colander has no verdict for this {noun}, so nothing from it is hidden, collapsed or labeled.</p>
		</Notice>
	{:else if s.verdict === 'clear'}
		<Notice title="This {noun} is already Clear">
			<p>It is allowed for everyone, at every strictness level. There is nothing to appeal.</p>
		</Notice>
	{:else if s.appeal_open}
		<Notice title="An appeal is already open">
			<p>Use the link in the email you received to check its status. The {noun} is shown as Disputed until staff decide.</p>
		</Notice>
	{/if}

	{#if appealable && s?.verdict}
		<div class="layout">
			<form class="card form" onsubmit={submit} novalidate>
				<p class="current">Current verdict <VerdictOrNone verdict={s.verdict} /></p>
				<div class="field">
					<label class="field-label" for="appeal-email">Email</label>
					<Input id="appeal-email" type="email" autocomplete="email" required bind:value={email} aria-describedby="email-hint" />
					<p class="field-hint" id="email-hint">We send the appeal link and the outcome here. It is never published.</p>
				</div>
				<div class="field">
					<label class="field-label" for="appeal-statement">Your statement</label>
					<Textarea id="appeal-statement" rows={7} maxlength={2000} required bind:value={statement} aria-describedby="statement-hint" />
					<p class="field-hint" id="statement-hint">
						How is the {noun} made? Who films, writes and edits it, and what is AI used for, if anything. Your statement is
						shown to staff, and their reasoning is published.
					</p>
				</div>
				{#if formError}<p class="field-error" role="alert">{formError}</p>{/if}
				<div>
					<button type="submit" class="uin-btn uin-btn-primary btn-lg" disabled={sending}>
						<Scale size={16} strokeWidth={1.75} aria-hidden="true" />
						<span>{sending ? 'Starting the appeal' : 'Start the appeal'}</span>
					</button>
				</div>
			</form>

			<aside class="steps" aria-labelledby="steps-title">
				<h2 class="steps-title" id="steps-title">What happens next</h2>
				<ol>
					<li><strong>You get a code.</strong> It looks like <span class="mono">colander-7KQ2M9XD</span>.</li>
					<li><strong>Add it to your {noun}.</strong> Put it in the description or bio, then choose Verify.</li>
					<li><strong>Disputed while we look.</strong> Once verified, nothing from the {noun} is hidden.</li>
					<li><strong>A published decision.</strong> Staff uphold or deny the appeal, and the reasoning goes in the decision log.</li>
				</ol>
				<p class="t-caption muted">Unverified appeals expire after 14 days. Appeals are free.</p>
			</aside>
		</div>
	{/if}
</div>

<style>
	.page {
		padding-top: var(--cl-s6);
	}
	.back {
		font: 600 14px/20px var(--cl-font);
	}
	.head {
		display: grid;
		gap: var(--cl-s3);
		padding: var(--cl-s5) 0 var(--cl-s6);
	}
	.head .t-display {
		overflow-wrap: anywhere;
	}
	.layout {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		gap: var(--cl-s6);
		align-items: start;
	}
	.form {
		display: grid;
		gap: var(--cl-s5);
	}
	.current {
		display: flex;
		align-items: center;
		gap: var(--cl-s2);
		font: 600 14px/20px var(--cl-font);
	}
	.steps {
		padding-top: var(--cl-s2);
	}
	.steps-title {
		font: 600 16px/24px var(--cl-font);
		margin-bottom: var(--cl-s3);
	}
	.steps ol {
		list-style: none;
		counter-reset: step;
		display: grid;
		gap: var(--cl-s4);
		font: var(--cl-body);
		color: var(--cl-text-muted);
		margin-bottom: var(--cl-s4);
	}
	.steps li {
		counter-increment: step;
		position: relative;
		padding-left: 36px;
	}
	.steps li::before {
		content: counter(step);
		position: absolute;
		left: 0;
		top: -2px;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: 1.5px solid var(--cl-text);
		color: var(--cl-text);
		font: 700 12px/1 var(--cl-font);
	}
	.steps strong {
		display: block;
		color: var(--cl-text);
		font-weight: 600;
	}
	@media (max-width: 760px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}
</style>
