<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { PLATFORM_NAME, SOURCE_NOUN, VerdictChip, canAppeal, sourcePath, type Platform } from '@colander/shared';
	import type { Appeal, SourceResponse } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import Textarea from '@colander/shared/components/ui/textarea/textarea.svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import Scale from '@lucide/svelte/icons/scale';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import AppealFrame from '#lib/components/AppealFrame.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';

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

<AppealFrame
	back={{ href: sourcePath(platform, id), label: 'Back to the source page' }}
	eyebrow="Appeal"
	title="Appeal the verdict for {name}"
	lede="If this {PLATFORM_NAME[platform]} {noun} is yours and the verdict is wrong, tell us why. You prove the {noun} is yours with a short code, and nothing from it is hidden while staff review."
	steps={[
		{ label: 'Code', state: 'current', detail: 'Start to get your code' },
		{ label: 'Verify', state: 'later' },
		{ label: 'Under review', state: 'later' },
		{ label: 'Decision', state: 'later' }
	]}
>
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
		<form class="uin-card uin-card-lg uin-card-pad form" onsubmit={submit} novalidate>
			<p class="current">Current verdict <VerdictChip verdict={s.verdict} /></p>
			<div class="field">
				<label class="field-label" for="appeal-email">Email</label>
				<Input id="appeal-email" size="lg" type="email" autocomplete="email" required bind:value={email} aria-describedby="email-hint" />
				<p class="field-hint" id="email-hint">We send the appeal link and the outcome here. It is never published.</p>
			</div>
			<div class="field">
				<label class="field-label" for="appeal-statement">Your statement</label>
				<Textarea id="appeal-statement" rows={7} maxlength={2000} required bind:value={statement} aria-describedby="statement-hint" />
				<p class="field-hint" id="statement-hint">
					How is the {noun} made? Who films, writes and edits it, and what is AI used for, if anything. Your statement is shown to staff,
					and their reasoning is published.
				</p>
			</div>
			{#if formError}<p class="field-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{formError}</p>{/if}
			<div>
				<Button type="submit" variant="primary" size="xl" disabled={sending}>
					<Scale size={16} aria-hidden="true" />{sending ? 'Starting the appeal' : 'Start the appeal'}
				</Button>
			</div>
		</form>

		<section class="next" aria-labelledby="next-title">
			<h2 id="next-title">What happens next</h2>
			<ol>
				<li><strong>You get a code.</strong> It looks like <span class="cl-figure">colander-7KQ2M9XD</span>.</li>
				<li><strong>Add it to your {noun}.</strong> Put it in the description or bio, then ask us to check it.</li>
				<li><strong>Unhidden while staff review.</strong> Once verified, the {noun} shows as Disputed and nothing from it is hidden.</li>
				<li><strong>A published decision.</strong> Staff uphold or deny the appeal, and the reasoning goes in the decision log.</li>
			</ol>
			<p class="cl-caption cl-muted">Unverified appeals expire after 14 days.</p>
		</section>
	{/if}
</AppealFrame>

<style>
	.form {
		display: grid;
		gap: 24px;
	}
	.current {
		display: flex;
		align-items: center;
		gap: 8px;
		font: var(--cl-body-strong);
	}
	.next h2 {
		margin-bottom: 12px;
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.next ol {
		display: grid;
		gap: 12px;
		margin-bottom: 12px;
		padding-left: 20px;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	.next strong {
		color: var(--cl-text);
	}
</style>
