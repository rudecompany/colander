<!--
@component AuthCard: the one sign-in card for /account, /auth, /plans/welcome and the console. 440
wide and centered on the page, with the mark, an H1, a lede and the content (the emailed-link
form, or a status).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ColanderMark } from '@colander/shared';

	let { eyebrow = 'Account', title, lede, children }: { eyebrow?: string; title: string; lede?: string; children: Snippet } = $props();
</script>

<div class="cl-container page-body wrap">
	<section class="auth uin-card uin-card-lg uin-card-pad" aria-labelledby="auth-title">
		<ColanderMark size={32} />
		<p class="cl-eyebrow">{eyebrow}</p>
		<h1 class="cl-display" id="auth-title">{title}</h1>
		{#if lede}<p class="lede">{lede}</p>{/if}
		<div class="content">{@render children()}</div>
	</section>
</div>

<style>
	.wrap {
		display: grid;
		justify-items: center;
		padding-top: var(--cl-s8);
	}
	.auth {
		display: grid;
		justify-items: start;
		gap: 12px;
		width: min(100%, 440px);
		padding: 32px;
	}
	h1 {
		overflow-wrap: anywhere;
	}
	.lede {
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	.content {
		display: grid;
		gap: 16px;
		width: 100%;
		margin-top: 12px;
	}
	@media (max-width: 639px) {
		.wrap {
			padding-top: var(--cl-s6);
		}
		.auth {
			padding: 24px;
		}
	}
</style>
