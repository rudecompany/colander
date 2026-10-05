<!--
@component ConnectBrowser: connects Colander in a browser to this account with a pairing code
(contracts 7): Plus with kind "plan", the review side panel with kind "reviewer". Show a code makes
one and shows it with Copy and its 10-minute countdown, then checks every 2 seconds until the
extension takes it: "Connected Colander 1.4.0 in Firefox". The code works once, in any browser,
also one on another computer, and a new code ends the one before. Each step replaces what had
focus (Show a code goes away when the code shows), so focus moves to the step's content.
-->
<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { BROWSER_NAME, type PairCreated, type PairKind, type PairStatus } from '@colander/shared/api';
	import { CopyButton } from '@colander/shared';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import { api, ApiError, errorText } from '#lib/api.ts';
	import Notice from './Notice.svelte';

	let { kind }: { kind: PairKind } = $props();

	const WHERE: Record<PairKind, string> = {
		plan: "In the browser you want to connect, open Colander's Options, choose Plan and type this code.",
		reviewer: "In the browser you review in, open Colander's side panel and type this code."
	};
	const DONE: Record<PairKind, string> = {
		plan: 'Plus is on there.',
		reviewer: 'The side panel can now open the review queue there. Any earlier side panel connection stopped working.'
	};

	type State =
		| { step: 'idle' | 'working' | 'expired' }
		| { step: 'code'; id: string; code: string; expires: number }
		| { step: 'connected'; version: string | null; browser: string | null }
		| { step: 'error'; message: string };
	let pair = $state<State>({ step: 'idle' });
	let now = $state(Date.now());
	let stepEl = $state<HTMLElement>();

	// The code, the connection, an ended code or an error: focus follows, so it is read out and the
	// keyboard carries on from there.
	$effect(() => {
		if (pair.step === 'idle' || pair.step === 'working') return;
		void tick().then(() => stepEl?.focus());
	});
	let timers: ReturnType<typeof setInterval>[] = [];

	function stop() {
		for (const t of timers) clearInterval(t);
		timers = [];
	}
	onDestroy(stop);

	async function show() {
		if (pair.step === 'working') return;
		stop();
		pair = { step: 'working' };
		try {
			const made = await api<PairCreated>('/v1/pair', { method: 'POST', body: { kind } });
			now = Date.now();
			pair = { step: 'code', id: made.id, code: made.code, expires: Date.parse(made.expires_at) };
			watch(made.id);
		} catch (e) {
			pair = {
				step: 'error',
				message: e instanceof ApiError && e.code === 'no_plan' ? 'There is no active plan on this account to connect.' : errorText(e)
			};
		}
	}

	/** The countdown every second, and the code's status every 2 seconds while it is on screen. */
	function watch(id: string) {
		timers.push(
			setInterval(() => {
				now = Date.now();
				if (pair.step === 'code' && now >= pair.expires) {
					stop();
					pair = { step: 'expired' };
				}
			}, 1000),
			setInterval(async () => {
				try {
					const s = await api<PairStatus>(`/v1/pair/${encodeURIComponent(id)}`);
					if (pair.step !== 'code' || pair.id !== id) return;
					if (s.status === 'claimed') {
						stop();
						pair = { step: 'connected', version: s.ext_version, browser: s.browser ? BROWSER_NAME[s.browser] : null };
					} else if (s.status === 'expired') {
						stop();
						pair = { step: 'expired' };
					}
				} catch {
					// Offline for a moment: the next check tries again, and the countdown still ends it.
				}
			}, 2000)
		);
	}

	const left = $derived(pair.step === 'code' ? Math.max(0, Math.ceil((pair.expires - now) / 1000)) : 0);
	const clock = $derived(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`);
</script>

{#if pair.step !== 'idle' && pair.step !== 'working'}
	<div class="step" tabindex="-1" bind:this={stepEl}>
		{#if pair.step === 'code'}
			<div class="code-card">
				<p class="cl-body">{WHERE[kind]}</p>
				<div class="code-row">
					<output class="code" aria-label="Pairing code {pair.code.split('').join(' ')}">{pair.code}</output>
					<CopyButton text={pair.code} size="xl" />
				</div>
				<p class="cl-caption cl-muted">Works once, for {clock} more. This page updates when Colander takes it.</p>
				<p class="warn"><ShieldAlert size={16} aria-hidden="true" />Never share this code. Colander staff never ask for it.</p>
			</div>
		{:else if pair.step === 'connected'}
			<Notice tone="success" title={`Connected Colander${pair.version ? ` ${pair.version}` : ''}${pair.browser ? ` in ${pair.browser}` : ''}.`}>
				<p>{DONE[kind]}</p>
			</Notice>
		{:else if pair.step === 'expired'}
			<Notice title="This code has ended"><p>It was not used within 10 minutes, or a newer code replaced it. Show a new one when you are ready.</p></Notice>
		{:else if pair.step === 'error'}
			<Notice tone="error" title="No code was made"><p>{pair.message}</p></Notice>
		{/if}
	</div>
{/if}

{#if pair.step !== 'code'}
	<div class="row">
		<Button variant={kind === 'plan' ? 'primary' : 'secondary'} size="xl" onclick={show} aria-disabled={pair.step === 'working'}>
			<KeyRound size={16} aria-hidden="true" />{pair.step === 'connected' ? 'Connect another browser' : pair.step === 'working' ? 'Making a code' : 'Show a code'}
		</Button>
	</div>
{/if}

<style>
	/* Focus lands here only from script, after a step replaced the button that had it. */
	.step:focus {
		outline: none;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--cl-s2);
	}
	.code-card {
		display: grid;
		gap: var(--cl-s3);
		padding: var(--cl-s4);
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface-raised);
	}
	.code-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--cl-s3);
	}
	.code {
		font: var(--cl-stat);
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.12em;
	}
	.warn {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		font: var(--cl-body-strong);
	}
	.warn :global(svg) {
		flex: none;
		margin-top: 2px;
	}
</style>
