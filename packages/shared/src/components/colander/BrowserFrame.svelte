<!--
@component BrowserFrame: a flat, code-drawn browser window for the hero, welcome and store art.
A 40 px chrome bar with 3 neutral dots, an address field, and the toolbar icon (the --cl-mark
mark at 16) with a Chrome-style count badge. Children are the page; `docked` floats over the
page's top right, 8 px below the toolbar icon (the popup).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import ColanderMark from './ColanderMark.svelte';
	import { TOOLBAR } from '../../glyphs';

	let {
		address = 'Recreated feed, not a real site',
		count = 0,
		paused = false,
		height,
		children,
		docked
	}: { address?: string; count?: number; paused?: boolean; height?: number; children?: Snippet; docked?: Snippet } = $props();
</script>

<div class="frame" style:height={height ? `${height}px` : undefined}>
	<div class="chrome">
		<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>
		<span class="address">{address}</span>
		<span class="tool" style:color={paused ? TOOLBAR.paused : TOOLBAR.mark}>
			<ColanderMark size={16} outline={paused} label={paused ? 'Colander, paused' : 'Colander'} />
			{#if count > 0 && !paused}
				<span class="badge" style:background={TOOLBAR.badge} style:color={TOOLBAR.badgeText} aria-hidden="true">{count}</span>
				<span class="cl-sr-only">{count} hidden on this page</span>
			{/if}
		</span>
	</div>
	<div class="page">
		{#if children}{@render children()}{/if}
		{#if docked}<div class="docked">{@render docked()}</div>{/if}
	</div>
</div>

<style>
	.frame {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.chrome {
		display: flex;
		flex: none;
		align-items: center;
		gap: 12px;
		height: 40px;
		padding: 0 12px;
		border-bottom: 1px solid var(--cl-border);
		background: var(--cl-surface-raised);
	}
	.dots {
		display: inline-flex;
		gap: 6px;
	}
	.dots i {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--cl-dot-strong);
	}
	.address {
		flex: 1;
		min-width: 0;
		height: 28px;
		padding: 0 12px;
		overflow: hidden;
		border-radius: var(--cl-r-chip);
		background: var(--cl-surface);
		color: var(--cl-text-muted);
		font: var(--cl-figure);
		letter-spacing: 0.02em;
		line-height: 28px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tool {
		position: relative;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
	}
	.badge {
		position: absolute;
		right: -4px;
		bottom: -2px;
		min-width: 16px;
		height: 16px;
		padding: 0 4px;
		border-radius: var(--cl-r-full);
		font: var(--cl-figure);
		line-height: 16px;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}
	.page {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}
	/* A hairline as well as the shadow, as Chrome draws its own popups: in dark the shadow alone does
	   not read on a near-black page. */
	.docked {
		position: absolute;
		top: 8px;
		right: 12px;
		z-index: 3;
		overflow: hidden;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		box-shadow: var(--cl-shadow-pop);
	}
</style>
