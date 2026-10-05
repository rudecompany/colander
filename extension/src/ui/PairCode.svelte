<!--
@component PairCode: takes a pairing code from the website (contracts 7), the one way Plus and
review reach this browser. The background claims it and keeps the plan or reviewer token it gets.
In Firefox the click first asks to allow sending a sign-in token (lib/consent.ts), straight from the
click, as Firefox requires. `hint` says where the code comes from. Success names the account the code
came from, so a person handed someone else's code can tell; `onpaired` lets the page move focus
when the form goes away with it.
-->
<script lang="ts">
	import type { PairKind } from '@colander/shared/api';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import Input from '@colander/shared/components/ui/input/input.svelte';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import { ask } from '../lib/consent';
	import type { PairReply } from '../lib/messages';
	import { send } from './store.svelte';

	let { id = 'pair-code', hint, onpaired }: { id?: string; hint: string; onpaired?: (kind: PairKind, done: string) => void } = $props();

	const DONE: Record<PairKind, string> = {
		plan: 'Plus is on in this browser.',
		reviewer: 'The review queue opens in the side panel.'
	};

	let code = $state('');
	let busy = $state(false);
	let error = $state('');
	let done = $state('');

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		// Before any await: Firefox shows its consent prompt only straight from the click or Enter.
		const consent = ask(['authenticationInfo']);
		busy = true;
		error = '';
		done = '';
		const r: PairReply = (await consent)
			? await send<PairReply>({ type: 'pair', code }).catch(() => ({ ok: false, error: 'Could not reach Colander. Try again in a moment.' }))
			: { ok: false, error: 'Firefox did not allow Colander to use a sign-in token, so nothing was connected. Choose Connect to be asked again.' };
		busy = false;
		if (r.ok) {
			code = '';
			done = `Connected${r.account ? ` to ${r.account}` : ''}. ${DONE[r.kind]}`;
			onpaired?.(r.kind, done);
		} else error = r.error;
	}
</script>

<form class="pair" onsubmit={submit}>
	<label for={id} class="label">Code from the website</label>
	<div class="row">
		<Input
			{id}
			class="grow"
			bind:value={code}
			maxlength={12}
			autocomplete="off"
			autocapitalize="characters"
			spellcheck={false}
			placeholder="KXQ4-JP7M"
			aria-describedby="{id}-hint"
			aria-invalid={error ? 'true' : undefined}
		/>
		<Button variant="primary" type="submit" aria-disabled={busy}>{busy ? 'Connecting' : 'Connect'}</Button>
	</div>
	<p class="hint" id="{id}-hint">{hint}</p>
	{#if error}<p class="msg" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</p>{/if}
	{#if done}<p class="msg" role="status"><CircleCheck size={16} aria-hidden="true" />{done}</p>{/if}
</form>

<style>
	.pair {
		display: grid;
		gap: 4px;
		width: 100%;
	}
	.label {
		font: var(--cl-body-strong);
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.row :global(.grow) {
		flex: 1;
		min-width: 0;
	}
	/* The code reads like the website shows it: capitals, even digits, a little air between them. */
	.row :global(input) {
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.hint {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.msg {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin-top: 4px;
	}
	.msg :global(svg) {
		flex: none;
		margin-top: 2px;
	}
</style>
