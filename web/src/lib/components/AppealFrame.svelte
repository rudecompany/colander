<!--
@component AppealFrame: the shared frame of the appeal pages. A back link, the title, the four-step
Lifecycle (Code, Verify, Under review, Decision) across grid columns 3 to 10, and the content on
the same columns. Appeals are free, and these pages never ask for money.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Lifecycle, type LifecycleStep } from '@colander/shared';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';

	let {
		back,
		eyebrow,
		title,
		lede,
		steps,
		children
	}: { back?: { href: string; label: string }; eyebrow: string; title: string; lede?: string; steps: LifecycleStep[]; children: Snippet } = $props();
</script>

<div class="cl-container page-top">
	<div class="cols">
		{#if back}<a class="back" href={back.href}><ArrowLeft size={16} aria-hidden="true" />{back.label}</a>{/if}
		<p class="cl-eyebrow">{eyebrow}</p>
		<h1 class="cl-display">{title}</h1>
		{#if lede}<p class="lede">{lede}</p>{/if}
		<div class="steps"><Lifecycle {steps} direction="horizontal" label="Appeal steps" /></div>
	</div>
</div>
<div class="cl-container page-body">
	<div class="cols body">
		{@render children()}
		<p class="free cl-caption">Appeals are free.</p>
	</div>
</div>

<style>
	.cols {
		display: grid;
		justify-items: start;
		gap: 12px;
		width: min(100%, 792px);
		margin-inline: auto;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 12px;
		font: var(--cl-body-strong);
		text-decoration: none;
	}
	h1 {
		overflow-wrap: anywhere;
	}
	.lede {
		max-width: 68ch;
		color: var(--cl-text-muted);
		font: var(--cl-body-lg);
	}
	.steps {
		width: 100%;
		margin-top: 24px;
		padding: 20px 24px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.body {
		gap: 24px;
		justify-items: stretch;
	}
	.free {
		color: var(--cl-text-muted);
	}
</style>
