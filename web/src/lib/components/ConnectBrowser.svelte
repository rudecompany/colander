<!-- @component Connect this browser: fetches a signed plan token (POST /v1/entitlement) and hands it to the extension. -->
<script lang="ts">
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import Plug from '@lucide/svelte/icons/plug';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Button from '@colander/shared/components/ui/button/button.svelte';
	import { api, ApiError } from '#lib/api.ts';
	import { sendToExtension, type ExtensionState } from '#lib/extension.ts';
	import Loading from './Loading.svelte';
	import Notice from './Notice.svelte';

	let { ext, canConnect, onrecheck }: { ext: ExtensionState; canConnect: boolean; onrecheck: () => void } = $props();

	let connect = $state<{ kind: 'idle' | 'working' } | { kind: 'done' | 'error'; message: string }>({ kind: 'idle' });

	async function connectBrowser() {
		connect = { kind: 'working' };
		try {
			const { token } = await api<{ token: string }>('/v1/entitlement', { method: 'POST' });
			await sendToExtension({ type: 'colander:plan-token', token });
			connect = { kind: 'done', message: 'Connected. Plus features are on in this browser.' };
		} catch (e) {
			connect = {
				kind: 'error',
				message:
					e instanceof ApiError
						? e.code === 'no_plan'
							? 'There is no active plan on this account to connect.'
							: e.message
						: 'Colander did not answer. Make sure it is installed and turned on in this browser, then try again.'
			};
		}
	}
</script>

{#if ext.kind === 'checking'}
	<Loading label="Looking for Colander in this browser" />
{:else if ext.kind === 'not_chrome'}
	<Notice title="This browser is not Chrome">
		<p>Colander runs in Chrome on desktop. Open this page in Chrome, with Colander installed, to connect it.</p>
	</Notice>
{:else if ext.kind === 'missing'}
	<Notice title="Colander is not installed in this browser">
		<p>Add it from the Chrome Web Store, then come back to this page.</p>
	</Notice>
	<div class="row">
		<Button variant="primary" size="xl" href={PUBLIC_STORE_URL}><Plus size={16} aria-hidden="true" />Add to Chrome</Button>
		<Button variant="secondary" size="xl" onclick={onrecheck}><RefreshCw size={16} aria-hidden="true" />Check again</Button>
	</div>
{:else}
	<p class="cl-body">Colander {ext.version} is installed here.</p>
	{#if canConnect}
		<div class="row">
			<Button variant="primary" size="xl" onclick={connectBrowser} disabled={connect.kind === 'working'}>
				<Plug size={16} aria-hidden="true" />{connect.kind === 'working' ? 'Connecting' : 'Connect this browser'}
			</Button>
		</div>
	{:else}
		<p class="cl-body cl-muted">Once you have Plus, connect this browser here.</p>
	{/if}
{/if}
{#if connect.kind === 'done'}<Notice tone="success" title={connect.message} />{/if}
{#if connect.kind === 'error'}<Notice tone="error" title="Not connected"><p>{connect.message}</p></Notice>{/if}

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--cl-s2);
	}
</style>
