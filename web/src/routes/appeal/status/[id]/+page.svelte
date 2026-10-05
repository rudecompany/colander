<script lang="ts">
	import { page } from '$app/state';
	import { PLATFORM_NAME, SOURCE_NOUN, VerdictChip, type LifecycleStep, type Platform } from '@colander/shared';
	import type { Appeal, AppealStatus } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import BadgeCheck from '@lucide/svelte/icons/badge-check';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import AppealFrame from '#lib/components/AppealFrame.svelte';
	import ArrowLink from '#lib/components/ArrowLink.svelte';
	import { api, errorText } from '#lib/api.ts';
	import { appealPath, fmtDate, fmtShortDate, sourcePath } from '@colander/shared';
	import { CopyButton } from '@colander/shared';
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
			meaning: (n) => `Add the code below to your ${n}, then ask us to check it. Until then, the verdict stays as it is.`
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

	/** Code, Verify, Under review, Decision: filled when done, a ring for the current step. */
	const steps = $derived.by((): LifecycleStep[] => {
		const st = appeal?.status;
		const verified = !!st && ['under_review', 'upheld', 'denied'].includes(st);
		const decided = st === 'upheld' || st === 'denied';
		return [
			{ label: 'Code', state: appeal ? 'done' : 'current', detail: appeal ? fmtShortDate(appeal.created_at) : undefined },
			{
				label: 'Verify',
				state: verified ? 'done' : appeal ? 'current' : 'later',
				detail: appeal?.verified_at ? fmtShortDate(appeal.verified_at) : st === 'pending_manual' ? 'Manual check' : st === 'expired' ? 'Expired' : undefined
			},
			{ label: 'Under review', state: decided ? 'done' : verified ? 'current' : 'later' },
			{ label: 'Decision', state: decided ? 'done' : 'later', detail: decided && appeal?.resolved_at ? fmtShortDate(appeal.resolved_at) : undefined }
		];
	});
	const checkLabel = $derived(appeal?.platform === 'yt' ? 'Check my description' : appeal?.platform === 'fb' ? 'Check my page intro' : 'Check my bio');
</script>

<svelte:head>
	<title>Appeal status · Colander</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<AppealFrame
	back={appeal ? { href: sourcePath(appeal.platform, appeal.source_id), label: 'Back to the source page' } : undefined}
	eyebrow={appeal ? `Appeal for a ${PLATFORM_NAME[appeal.platform]} ${noun}` : 'Appeal'}
	title={appeal ? (appeal.source_name ?? appeal.source_id) : 'Appeal status'}
	{steps}
>
	{#if !secret}
		<Notice title="This link is incomplete">
			<p>Open the link from the email we sent when you started the appeal. It includes the key to this page.</p>
		</Notice>
	{:else if loadError}
		<div class="error-box">
			<Notice tone="error" title="We could not open this appeal"><p>{loadError}</p></Notice>
			<Button variant="secondary" size="xl" onclick={load}><RefreshCw size={16} aria-hidden="true" />Try again</Button>
		</div>
	{:else if !appeal}
		<Loading label="Loading" />
	{:else}
		{@const st = STATUS[appeal.status]}
		<section class="uin-card uin-card-lg uin-card-pad status" aria-labelledby="status-title" data-status={appeal.status}>
			<p class="cl-caption cl-muted">Status, started {fmtDate(appeal.created_at)}</p>
			<h2 class="cl-title" id="status-title">{st.title}</h2>
			<p class="meaning">{st.meaning(noun, appeal.platform)}</p>

			{#if appeal.status === 'awaiting_verification' || appeal.status === 'pending_manual'}
				<div class="step" aria-labelledby="code-title">
					<h3 id="code-title">Your code</h3>
					<div class="code-row">
						<span class="code cl-figure">{appeal.code}</span>
						<CopyButton text={appeal.code} label="Copy code" size="xl" />
					</div>
					<div class="howto">
						<p class="howto-title">Add it to your {PLATFORM_NAME[appeal.platform]} {noun}</p>
						<ol>
							{#each INSTRUCTIONS[appeal.platform] as line (line)}<li>{line}</li>{/each}
						</ol>
						<p class="cl-caption cl-muted">The code proves you control the {noun}. You can take it out once the appeal is verified.</p>
					</div>
					{#if appeal.status === 'awaiting_verification'}
						<div class="verify">
							<Button variant="primary" size="xl" onclick={verify} disabled={verifying}>
								<BadgeCheck size={16} aria-hidden="true" />{verifying ? 'Checking' : checkLabel}
							</Button>
							<p class="cl-muted small">We look for the code on your {noun}. It can take a minute after you save.</p>
						</div>
						{#if verifyError}<p class="field-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{verifyError}</p>{/if}
					{/if}
				</div>
			{:else if appeal.status === 'under_review'}
				<p class="disputed"><VerdictChip verdict="disputed" size="lg" /><span>Unhidden while staff review</span></p>
			{/if}

			{#if appeal.reasoning}
				<div class="step">
					<h3>Reasoning</h3>
					<p class="quote">{appeal.reasoning}</p>
					<ArrowLink href="/log">Read it in the decision log</ArrowLink>
				</div>
			{/if}

			{#if appeal.status === 'expired'}
				<p><Button variant="secondary" size="xl" href={appealPath(appeal.platform, appeal.source_id)}>Start a new appeal</Button></p>
			{/if}
		</section>

		<section class="statement" aria-labelledby="statement-title">
			<h2 id="statement-title">Your statement</h2>
			<p class="quote">{appeal.statement}</p>
		</section>

		<p class="cl-caption cl-muted">Keep this page's address to check on your appeal. It is also in the email we sent you.</p>
	{/if}
</AppealFrame>

<style>
	.error-box {
		display: grid;
		justify-items: start;
		gap: 12px;
	}
	.status {
		display: grid;
		gap: 8px;
	}
	.meaning {
		max-width: 60ch;
		font: var(--cl-body-lg);
	}
	.step {
		display: grid;
		justify-items: start;
		gap: 12px;
		margin-top: 16px;
		padding-top: 24px;
		border-top: 1px solid var(--cl-border);
	}
	.step h3 {
		font: var(--cl-body-lg);
		font-weight: 600;
	}
	.code-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
	}
	.code {
		display: inline-flex;
		align-items: center;
		height: 40px;
		padding: 0 16px;
		border: 1px solid var(--cl-border-strong);
		border-radius: var(--cl-r-chip);
		background: var(--cl-surface-raised);
		font-size: 16px;
		line-height: 24px;
		user-select: all;
	}
	.howto {
		display: grid;
		gap: 8px;
		width: 100%;
		padding: 16px;
		border-radius: var(--cl-r-card);
		background: var(--cl-surface-raised);
		font: var(--cl-body);
	}
	.howto-title {
		font: var(--cl-body-strong);
	}
	.howto ol {
		display: grid;
		gap: 4px;
		padding-left: 20px;
	}
	.verify {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px 16px;
	}
	.small {
		font: var(--cl-body);
	}
	.disputed {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		margin-top: 8px;
		font: var(--cl-body-strong);
	}
	.quote {
		padding-left: 16px;
		border-left: 2px solid var(--cl-border-strong);
		font: var(--cl-body-lg);
		white-space: pre-line;
	}
	.statement {
		display: grid;
		gap: 12px;
	}
	.statement h2 {
		font: var(--cl-body-lg);
		font-weight: 600;
	}
</style>
