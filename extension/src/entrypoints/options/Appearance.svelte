<!-- @component Appearance: larger chips with plain-language words, for readers who want them. -->
<script lang="ts">
	import { VerdictChip } from '@colander/shared';
	import Switch from '@colander/shared/components/ui/switch/switch.svelte';
	import { VERDICTS } from '@colander/shared/verdicts';
	import { K, withDefaults, type Settings } from '../../lib/settings';
	import Card from '../../ui/Card.svelte';
	import Section from '../../ui/Section.svelte';
	import { send, stored } from '../../ui/store.svelte';

	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const settings = $derived(withDefaults(settingsStore.value));
</script>

<Section id="appearance" title="Appearance" description="How labels look on YouTube, TikTok, Instagram and Facebook.">
	<Card>
		<div class="row">
			<div>
				<p id="plain-label" class="strong">Larger, plain-language chips</p>
				<p class="muted t-caption">Bigger labels that spell out what each verdict means. Good for anyone who finds the short words unclear.</p>
			</div>
			<Switch checked={settings.plainChips} aria-labelledby="plain-label" onCheckedChange={(v) => send({ type: 'settings', patch: { plainChips: v } })} />
		</div>
		<div class="preview" aria-label="Preview">
			<p class="t-caption muted">Preview on a thumbnail</p>
			<div class="media">
				{#each VERDICTS.filter((v) => v !== 'clear') as v (v)}
					<VerdictChip verdict={v} tone="ink" plain={settings.plainChips} size={settings.plainChips ? 'lg' : 'md'} />
				{/each}
			</div>
		</div>
	</Card>
</Section>

<style>
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
	}
	.strong {
		font-weight: 600;
	}
	.preview {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding-top: 12px;
		border-top: 1px solid var(--cl-border);
	}
	.media {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 24px;
		border-radius: var(--cl-r-chip);
		background: linear-gradient(135deg, #8d6e63, #455a64);
	}
</style>
