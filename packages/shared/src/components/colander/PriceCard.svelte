<!--
@component PriceCard: Free or Plus, from PLAN_COPY. Free is a surface card with a secondary CTA;
Plus is the band card with an outline Recommended badge, the 14-day badge and a primary CTA.
`billing` shows /plans' billed line for a yearly or monthly choice; without it Plus reads
"$30 a year" and "or $3 a month". `size="site"` is the website (stat-lg, 40 buttons, padding
24); `app` is options (stat 28/32, 32 buttons, padding 16). No strikethrough, no percent-off.
-->
<script lang="ts">
	import '../ui/badge/badge.css';
	import '../ui/button/button.css';
	import Check from '@lucide/svelte/icons/check';
	import Button from '../ui/button/button.svelte';
	import { PLAN_COPY } from '../../copy';

	let {
		plan,
		billing,
		size = 'site',
		recommended = true,
		cta,
		cta2,
		headingLevel = 3
	}: {
		plan: 'free' | 'plus';
		billing?: 'year' | 'month';
		size?: 'site' | 'app';
		recommended?: boolean;
		/** Omit to show no button, as on a current plan. */
		cta?: { label?: string; href?: string; onclick?: () => void };
		/** A secondary action under the primary, such as /plans' direct purchase. */
		cta2?: { label: string; href?: string; onclick?: () => void; loading?: boolean };
		headingLevel?: 2 | 3 | 4;
	} = $props();

	const P = PLAN_COPY;
	const price = $derived(plan === 'free' ? P.free.price : billing === 'month' ? P.plus.monthly : P.plus.price);
	const sub = $derived(plan === 'free' ? P.free.line : billing ? P.plus.billed[billing] : P.plus.alt);
	const features = $derived(plan === 'free' ? P.free.features : P.plus.features);
	const btn = $derived(size === 'site' ? 'xl' : 'md');
	const badge = $derived(size === 'site' ? 'lg' : 'md');
</script>

<article class="price price-{size}" class:cl-band={plan === 'plus'}>
	<header class="head">
		<svelte:element this={`h${headingLevel}`} class="name">{plan === 'free' ? P.free.name : P.plus.name}</svelte:element>
		{#if plan === 'plus' && recommended}<span class="uin-badge uin-badge-{badge}">Recommended</span>{/if}
	</header>
	<p class="amount">{price}</p>
	<p class="sub">{sub}</p>
	{#if plan === 'plus'}<p><span class="uin-badge uin-badge-{badge}">{P.plus.trial}</span></p>{/if}
	<ul>
		{#each features as f (f)}<li><Check size={16} aria-hidden="true" /><span>{f}</span></li>{/each}
	</ul>
	{#if cta}
		<div class="cta">
			<Button
				variant={plan === 'plus' ? 'primary' : 'secondary'}
				size={btn}
				href={cta.href}
				onclick={cta.onclick}
				block={size === 'app' ? false : true}
			>
				{cta.label ?? (plan === 'free' ? P.free.cta : P.plus.cta)}
			</Button>
			{#if cta2}
				<Button variant="secondary" size={btn} href={cta2.href} onclick={cta2.onclick} loading={cta2.loading} block={size !== 'app'}>{cta2.label}</Button>
			{/if}
		</div>
	{/if}
</article>

<style>
	.price {
		display: flex;
		flex-direction: column;
		gap: 8px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		color: var(--cl-text);
	}
	.price.cl-band {
		border-color: var(--cl-band);
		background: var(--cl-band);
	}
	.price-site {
		padding: 24px;
	}
	.price-app {
		padding: 16px;
	}
	.head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.name {
		margin: 0;
		font: var(--cl-title);
	}
	p {
		margin: 0;
	}
	.amount {
		font-variant-numeric: tabular-nums;
	}
	.price-site .amount {
		margin-top: 8px;
		font: var(--cl-stat-lg);
	}
	.price-app .amount {
		font: var(--cl-stat);
	}
	.sub {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
	.price-site .sub {
		font: var(--cl-body);
	}
	ul {
		display: grid;
		gap: 8px;
		margin: 8px 0 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}
	li :global(svg) {
		flex: none;
		margin-top: 2px;
	}
	.cta {
		display: grid;
		gap: 8px;
		margin-top: auto;
		padding-top: 16px;
	}
	.price-app .cta {
		justify-items: start;
	}
</style>
