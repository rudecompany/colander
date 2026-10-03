<script lang="ts">
	import { page } from '$app/state';
	import { PUBLIC_STORE_URL } from '$app/env/public';
	import Heart from '@lucide/svelte/icons/heart';
	import Wordmark from './Wordmark.svelte';

	// No creator is asked for money while their case is open: never on source or appeal pages.
	const wide = $derived(page.url.pathname.startsWith('/console'));
	const showSupport = $derived(!/^\/(s|appeal)(\/|$)/.test(page.url.pathname));
</script>

<footer class="site-footer">
	<hr class="dot-rule" />
	<div class="wrap grid" class:wrap-wide={wide}>
		<div class="brand">
			<Wordmark size={32} />
			<p class="tagline">Drain the slop. Keep the substance.</p>
			<p class="t-body muted">A Chrome extension that hides AI slop on YouTube, TikTok, Instagram and Facebook, from shared lists anyone can read.</p>
			{#if showSupport}
				<a class="uin-btn uin-btn-outline uin-btn-md support" href="/support">
					<Heart size={16} strokeWidth={1.75} aria-hidden="true" />
					<span>Support our work</span>
				</a>
			{/if}
		</div>

		<nav aria-label="Product">
			<h2>Product</h2>
			<ul>
				<li><a href={PUBLIC_STORE_URL}>Add to Chrome</a></li>
				<li><a href="/definition">How it decides</a></li>
				<li><a href="/plans">Plans</a></li>
				<li><a href="/account">Account</a></li>
			</ul>
		</nav>
		<nav aria-label="Open records">
			<h2>Open records</h2>
			<ul>
				<li><a href="/log">Decision log</a></li>
				<li><a href="/transparency">Transparency</a></li>
				{#if showSupport}<li><a href="/supporters">Supporters</a></li>{/if}
				<li><a href="/definition#appeals">Appeals</a></li>
			</ul>
		</nav>
		<nav aria-label="Policies">
			<h2>Policies</h2>
			<ul>
				<li><a href="/privacy">Privacy</a></li>
				<li><a href="/terms">Terms</a></li>
				<li><a href="/transparency#independence">Independence rules</a></li>
			</ul>
		</nav>
	</div>
	<div class="wrap" class:wrap-wide={wide}>
		<div class="base">
			<p>No ads, no trackers, no analytics. Paying never changes a verdict.</p>
			<p>Colander is a working name.</p>
		</div>
	</div>
</footer>

<style>
	.site-footer {
		background: var(--cl-surface-raised);
	}
	.dot-rule {
		background-color: var(--cl-paper);
	}
	.grid {
		display: grid;
		grid-template-columns: 1.6fr 1fr 1fr 1fr;
		gap: var(--cl-s6);
		padding-block: var(--cl-s6) var(--cl-s5);
	}
	.brand {
		display: grid;
		gap: var(--cl-s3);
		align-content: start;
		max-width: 360px;
	}
	.tagline {
		font: 600 16px/24px var(--cl-font);
	}
	.support {
		justify-self: start;
		margin-top: var(--cl-s2);
	}
	h2 {
		font: 600 14px/20px var(--cl-font);
		color: var(--cl-text-muted);
		margin-bottom: var(--cl-s3);
	}
	ul {
		list-style: none;
		display: grid;
		gap: var(--cl-s2);
	}
	nav a {
		color: var(--cl-text);
		text-decoration: none;
		font: var(--cl-body);
	}
	nav a:hover {
		text-decoration: underline;
	}
	.base {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--cl-s2) var(--cl-s5);
		padding-block: var(--cl-s4) var(--cl-s6);
		border-top: 1px solid var(--cl-border);
		font: var(--cl-caption);
		color: var(--cl-text-muted);
	}
	@media (max-width: 860px) {
		.grid {
			grid-template-columns: 1fr 1fr;
		}
		.brand {
			grid-column: 1 / -1;
		}
	}
</style>
