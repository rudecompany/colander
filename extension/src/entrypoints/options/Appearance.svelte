<!-- @component Appearance: larger plain-language chips, a Tag button that is always in view, and a notice when a swipe feed skips a hidden video. -->
<script lang="ts">
	import { InPage, PageHeader, SettingRow } from '@colander/shared';
	import { DEMO_THUMBS_NOTE } from '@colander/shared/copy';
	import { chip, hyper, thumbSvg, THUMB_CSS, type InpageContext } from '@colander/shared/inpage';
	import Card from '@colander/shared/components/ui/card/card.svelte';
	import Switch from '@colander/shared/components/ui/switch/switch.svelte';
	import { K, withDefaults, type Settings } from '../../lib/settings';
	import { send, stored } from '../../ui/store.svelte';

	const settingsStore = stored<Partial<Settings> | undefined>(K.settings, undefined);
	const settings = $derived(withDefaults(settingsStore.value));

	// The preview is drawn by the same builders the extension uses on YouTube, TikTok, Instagram and Facebook.
	const PREVIEW_CSS =
		THUMB_CSS +
		`.pv{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;font:var(--cl-caption)}
		.pv figure{margin:0;display:grid;gap:8px}
		.th{position:relative;aspect-ratio:16/9;overflow:hidden;border-radius:10px}
		.th>svg{width:100%;height:100%}
		.on{position:absolute;top:8px;left:8px}
		figcaption{color:var(--cl-text-muted)}
		figure[data-current] figcaption{color:var(--cl-text);font:var(--cl-body-strong)}`;

	const preview = (plain: boolean) => (ctx: InpageContext) => {
		const h = hyper(ctx.doc);
		const fig = (isPlain: boolean, label: string) =>
			h(
				'figure',
				{ 'data-current': isPlain === plain || undefined },
				h('div', { class: 'th' }, thumbSvg(ctx.doc, 'tide-pool'), h('div', { class: 'on' }, chip(ctx, { verdict: 'ai_made', plain: isPlain }, { tone: 'ink' }))),
				h('figcaption', {}, label)
			);
		return h('div', { class: 'pv' }, fig(false, 'Default'), fig(true, 'Larger, plain-language'));
	};
</script>

<PageHeader variant="app" eyebrow="Options" title="Appearance" lede="How labels and notices look on YouTube, TikTok, Instagram and Facebook." />

<div class="cards">
	<Card>
		<SettingRow title="Larger, plain-language chips" description="Bigger labels that spell out what each verdict means, for anyone who finds the short words unclear.">
			{#snippet control({ labelledby, describedby })}
				<Switch checked={settings.plainChips} aria-labelledby={labelledby} aria-describedby={describedby} onCheckedChange={(v) => send({ type: 'settings', patch: { plainChips: v } })} />
			{/snippet}
		</SettingRow>
		<div class="preview">
			<div role="img" aria-label="Preview: an AI-made chip on a thumbnail, in the default size and in the larger, plain-language size">
				<InPage kind="preview" css={PREVIEW_CSS} build={preview(settings.plainChips)} />
			</div>
			<p class="caption">{DEMO_THUMBS_NOTE}</p>
		</div>
		<SettingRow title="Always show the Tag button" description="Off, the Tag button appears when you point at a card or move to it with the keyboard. It always shows in swipe feeds.">
			{#snippet control({ labelledby, describedby })}
				<Switch checked={settings.alwaysTag} aria-labelledby={labelledby} aria-describedby={describedby} onCheckedChange={(v) => send({ type: 'settings', patch: { alwaysTag: v } })} />
			{/snippet}
		</SettingRow>
		<SettingRow
			title="Say when a swipe feed skips a video"
			description="Off, Shorts, TikTok and Reels move past hidden videos without a word, and the popup lists them. On, a short notice says what was skipped, with Undo and Why."
		>
			{#snippet control({ labelledby, describedby })}
				<Switch checked={settings.skipNotice} aria-labelledby={labelledby} aria-describedby={describedby} onCheckedChange={(v) => send({ type: 'settings', patch: { skipNotice: v } })} />
			{/snippet}
		</SettingRow>
	</Card>
	<p class="caption">Colander follows your system's light or dark setting.</p>
</div>

<style>
	.cards {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 24px;
		margin-top: 32px;
	}
	.cards > :global(.uin-card) {
		padding-block: 0;
	}
	.preview {
		display: grid;
		gap: 12px;
		padding: 4px 0 16px;
		border-bottom: 1px solid var(--cl-border);
	}
	.caption {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.cards > .caption {
		margin-top: -12px;
	}
</style>
