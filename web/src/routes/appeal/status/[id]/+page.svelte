<script lang="ts">
	import { page } from '$app/state';
	import { PLATFORM_NAME, SOURCE_NOUN, type Platform } from '@colander/shared';
	import type { Appeal, AppealStatus } from '@colander/shared/api';
	import BadgeCheck from '@lucide/svelte/icons/badge-check';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { api, errorText } from '#lib/api.ts';
	import { appealPath, fmtDate, fmtDateTime, sourcePath } from '#lib/format.ts';
	import CopyButton from '#lib/components/CopyButton.svelte';
	import Loading from '#lib/components/Loading.svelte';
	import Notice from '#lib/components/Notice.svelte';

	const id = $derived(page.params.id ?? '');
	const secret = $derived(page.url.searchParams.get('secret') ?? '');

	let appeal = $state<Appeal | null>(null);
	let loadError = $state('');
	let verifying = $state(false);
	let verifyError = $state('');

	async function load() {
		loadError = '';
		try {
			appeal = (await api<{ appeal: Appeal }>(`/v1/appeals/${encodeURIComponent(id)}?secret=${encodeURIComponent(secret)}`)).appeal;
		} catch (e) {
			loadError = errorText(e);
		}
	}

	$effect(() => {
		if (secret) load();
	});

	async function verify() {
		verifying = true;
		verifyError = '';
		try {
			const res = await api<{ appeal?: Appeal } | undefined>(`/v1/appeals/${encodeURIComponent(id)}/verify`, {
				method: 'POST',
				body: { secret }
			});
			if (res?.appeal) appeal = res.appeal;
			else await load();
		} catch (e) {
			verifyError = errorText(e);
		} finally {
			verifying = false;
		}
	}

	const noun = $derived(appeal ? SOURCE_NOUN[appeal.platform] : 'source');

	const STATUS: Record<AppealStatus, { title: string; meaning: (noun: string, platform: Platform) => string }> = {
		awaiting_verification: {
			title: 'Waiting for the code',
			meaning: (n) => `Add the code below to your ${n}, then choose Verify. Until then, the verdict stays as it is.`
		},
		pending_manual: {
			title: 'Waiting for a manual check',
			meaning: (n, p) =>
				`${PLATFORM_NAME[p]} cannot be checked automatically, so a staff member will look for the code on your ${n}. Keep it in place until then.`
		},
		under_review: {
			title: 'Under review',
			meaning: (n) =>
				`Your ${n} is verified. It is shown to everyone as Disputed, and nothing from it is hidden while staff review your appeal.`
		},
		upheld: {
			title: 'Upheld',
			meaning: (n) => `Staff agreed with you. The verdict for your ${n} is now Clear, and the reasoning is published in the decision log.`
		},
		denied: {
			title: 'Denied',
			meaning: () => 'Staff kept the earlier verdict, which is now restored. The reasoning is published in the decision log.'
		},
		expired: {
			title: 'Expired',
			meaning: () => 'The code was not verified within 14 days, so this appeal closed. You can start a new one at any time.'
		}
	};

	const INSTRUCTIONS: Record<Platform, string[]> = {
		yt: ['Open YouTube Studio and choose Customization, then Basic info.', 'Paste the code anywhere in the description.', 'Choose Publish.'],
		tt: ['Open your profile and choose Edit profile.', 'Paste the code anywhere in your bio.', 'Choose Save.'],
		ig: ['Open your profile and choose Edit profile.', 'Paste the code anywhere in your bio.', 'Choose Done or Submit.'],
		fb: ['Open your page and choose Edit details or Edit bio.', 'Paste the code into the intro or bio.', 'Choose Save.']
	};

	const steps = $derived.by(() => {
		if (!appeal) return [];
		const verified = !['awaiting_verification', 'pending_manual', 'expired'].includes(appeal.status);
		const decided = appeal.status === 'upheld' || appeal.status === 'denied';
		return [
			{ label: 'Started', done: true, at: appeal.created_at },
			{ label: 'Verified', done: verified, at: appeal.verified_at },
			{ label: 'Decided', done: decided, at: appeal.resolved_at }
		];
	});
</script>

<svelte:head>
	<title>Appeal status · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap wrap-narrow page">
	{#if !secret}
		<header class="head"><p class="eyebrow">Appeal</p><h1 class="t-display">Appeal status</h1></header>
		<Notice title="This link is incomplete">
			<p>Open the link from the email we sent when you started the appeal. It includes the key to this page.</p>
		</Notice>
	{:else if loadError}
		<header class="head"><p class="eyebrow">Appeal</p><h1 class="t-display">Appeal status</h1></header>
		<div class="error-box">
			<Notice tone="error" title="We could not open this appeal"><p>{loadError}</p></Notice>
			<button type="button" class="uin-btn uin-btn-outline uin-btn-md" onclick={load}>
				<RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" /> Try again
			</button>
		</div>
	{:else if !appeal}
		<Loading label="Loading your appeal" />
	{:else}
		{@const st = STATUS[appeal.status]}
		<header class="head">
			<p class="eyebrow">Appeal for a {PLATFORM_NAME[appeal.platform]} {noun}</p>
			<h1 class="t-display">{appeal.source_name ?? appeal.source_id}</h1>
			<p class="t-body muted">
				<a href={sourcePath(appeal.platform, appeal.source_id)}>Source page</a> · Started {fmtDate(appeal.created_at)}
			</p>
		</header>

		<section class="card status" aria-labelledby="status-title" data-status={appeal.status}>
			<p class="t-caption muted">Status</p>
			<h2 class="t-title" id="status-title">{st.title}</h2>
			<p class="t-body-lg meaning">{st.meaning(noun, appeal.platform)}</p>
			<ol class="stepper" aria-label="Progress">
				{#each steps as step (step.label)}
					<li class:done={step.done}>
						<span class="dot" aria-hidden="true"></span>
						<span class="step-label">{step.label}</span>
						<span class="step-at">{step.done && step.at ? fmtDateTime(step.at) : 'Not yet'}</span>
					</li>
				{/each}
			</ol>
		</section>

		{#if appeal.status === 'awaiting_verification' || appeal.status === 'pending_manual'}
			<section class="block" aria-labelledby="code-title">
				<h2 class="t-title" id="code-title">Your code</h2>
				<div class="code-row">
					<span class="code mono">{appeal.code}</span>
					<CopyButton text={appeal.code} label="Copy code" />
				</div>
				<div class="card-quiet howto">
					<h3>Add it to your {PLATFORM_NAME[appeal.platform]} {noun}</h3>
					<ol>
						{#each INSTRUCTIONS[appeal.platform] as line (line)}<li>{line}</li>{/each}
					</ol>
					<p class="t-caption muted">The code proves you control the {noun}. You can take it out once the appeal is verified.</p>
				</div>
				{#if appeal.status === 'awaiting_verification'}
					<div class="verify">
						<button type="button" class="uin-btn uin-btn-primary btn-lg" onclick={verify} disabled={verifying}>
							<BadgeCheck size={16} strokeWidth={1.75} aria-hidden="true" />
							<span>{verifying ? 'Checking' : 'Verify'}</span>
						</button>
						<p class="t-body muted">We look for the code on your {noun}. It can take a minute after you save.</p>
					</div>
					{#if verifyError}<p class="field-error" role="alert">{verifyError}</p>{/if}
				{/if}
			</section>
		{/if}

		{#if appeal.reasoning}
			<section class="block" aria-labelledby="reasoning-title">
				<h2 class="t-title" id="reasoning-title">Reasoning</h2>
				<p class="quote">{appeal.reasoning}</p>
				<p class="t-body"><a href="/log">Read it in the decision log</a></p>
			</section>
		{/if}

		{#if appeal.status === 'expired'}
			<p><a class="uin-btn uin-btn-outline uin-btn-md" href={appealPath(appeal.platform, appeal.source_id)}>Start a new appeal</a></p>
		{/if}

		<section class="block" aria-labelledby="statement-title">
			<h2 class="t-title" id="statement-title">Your statement</h2>
			<p class="quote">{appeal.statement}</p>
		</section>

		<p class="keep t-caption muted">Keep this page's address to check on your appeal. It is also in the email we sent you.</p>
	{/if}
</div>

<style>
	.page {
		padding-top: var(--cl-s6);
		display: grid;
		gap: var(--cl-s6);
	}
	.head {
		display: grid;
		gap: var(--cl-s2);
	}
	.head .t-display {
		overflow-wrap: anywhere;
	}
	.error-box {
		display: grid;
		gap: var(--cl-s3);
		justify-items: start;
	}
	.status {
		display: grid;
		gap: var(--cl-s2);
	}
	.meaning {
		max-width: 60ch;
	}
	.stepper {
		list-style: none;
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		margin-top: var(--cl-s4);
		padding-top: var(--cl-s4);
		border-top: 1px solid var(--cl-border);
	}
	.stepper li {
		position: relative;
		display: grid;
		gap: 2px;
		padding-top: 22px;
	}
	.stepper li::before {
		content: '';
		position: absolute;
		top: 6px;
		left: 14px;
		right: 0;
		border-top: 2px dotted var(--w-control-border);
	}
	.stepper li:last-child::before {
		display: none;
	}
	.stepper li.done:has(+ li.done)::before {
		border-top-style: solid;
		border-top-color: var(--cl-text);
	}
	.dot {
		position: absolute;
		top: 0;
		left: 0;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid var(--w-control-border);
		background: var(--cl-surface);
	}
	.done .dot {
		border-color: var(--cl-text);
		background: var(--cl-text);
	}
	.step-label {
		font: 600 14px/20px var(--cl-font);
	}
	.step-at {
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	.block {
		display: grid;
		gap: var(--cl-s4);
	}
	.code-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--cl-s3);
	}
	.code {
		padding: var(--cl-s2) var(--cl-s4);
		border-radius: var(--cl-r-chip);
		border: 1px dashed var(--w-control-border);
		background: var(--cl-surface);
		font-size: 20px;
		line-height: 28px;
		letter-spacing: 0.02em;
	}
	.howto {
		display: grid;
		gap: var(--cl-s3);
	}
	.howto h3 {
		font: 600 16px/24px var(--cl-font);
	}
	.howto ol {
		padding-left: var(--cl-s5);
		display: grid;
		gap: 4px;
		font: var(--cl-body);
	}
	.verify {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--cl-s4);
	}
	.quote {
		padding-left: var(--cl-s4);
		border-left: 3px solid var(--cl-border);
		font: var(--cl-body-lg);
		white-space: pre-line;
	}
	@media (max-width: 520px) {
		.stepper {
			grid-template-columns: 1fr;
			gap: var(--cl-s3);
		}
		.stepper li {
			padding: 0 0 0 26px;
		}
		.stepper li::before {
			display: none;
		}
	}
</style>
