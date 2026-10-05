<!--
@component Lifecycle: a timeline of steps on perforation nodes: a filled dot for done, a ring for
the current step, a hollow dot for later. Shape, not color, tells them apart. Vertical by
default; `horizontal` lays the steps across with a perforated connector (the appeal page and the
welcome progress).
-->
<script lang="ts" module>
	export type LifecycleStep = { label: string; state: 'done' | 'current' | 'later'; detail?: string };
</script>

<script lang="ts">
	let { steps, direction = 'vertical', label }: { steps: LifecycleStep[]; direction?: 'vertical' | 'horizontal'; label?: string } = $props();
	const STATE_WORD = { done: 'Done', current: 'Current step', later: 'Later' } as const;
</script>

<ol class="lc lc-{direction}" aria-label={label}>
	{#each steps as s (s.label)}
		<li class="step" data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
			<span class="node" aria-hidden="true"></span>
			<span class="body">
				<span class="label">{s.label}<span class="cl-sr-only">, {STATE_WORD[s.state]}</span></span>
				{#if s.detail}<span class="detail">{s.detail}</span>{/if}
			</span>
		</li>
	{/each}
</ol>

<style>
	.lc {
		display: grid;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.step {
		position: relative;
		display: grid;
		grid-template-columns: 12px 1fr;
		gap: 12px;
	}
	.lc-vertical .step {
		padding-bottom: 16px;
	}
	.lc-vertical .step:last-child {
		padding-bottom: 0;
	}
	/* The perforated connector between nodes. */
	.lc-vertical .step:not(:last-child)::before {
		content: '';
		position: absolute;
		top: 20px;
		bottom: 2px;
		left: 4.5px;
		width: 3px;
		background: radial-gradient(circle at 1.5px 1.5px, var(--cl-dot-strong) 1.5px, transparent 1.6px) 0 0 / 3px 8px repeat-y;
	}
	.lc-horizontal {
		grid-auto-columns: minmax(0, 1fr);
		grid-auto-flow: column;
		gap: 8px;
	}
	.lc-horizontal .step {
		grid-template-columns: none;
		grid-template-rows: 12px auto;
		gap: 8px;
	}
	.lc-horizontal .step:not(:last-child)::before {
		content: '';
		position: absolute;
		top: 4.5px;
		right: 0;
		left: 20px;
		height: 3px;
		background: radial-gradient(circle at 1.5px 1.5px, var(--cl-dot-strong) 1.5px, transparent 1.6px) 0 0 / 8px 3px repeat-x;
	}
	.node {
		width: 12px;
		height: 12px;
		margin-top: 4px;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1.5px var(--cl-dot-strong);
	}
	.lc-horizontal .node {
		margin-top: 0;
	}
	[data-state='done'] .node {
		background: var(--cl-text);
		box-shadow: none;
	}
	[data-state='current'] .node {
		box-shadow:
			inset 0 0 0 3px var(--cl-text),
			inset 0 0 0 12px var(--cl-surface);
	}
	.body {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.label {
		font: var(--cl-body-strong);
	}
	[data-state='later'] .label {
		color: var(--cl-text-muted);
		font-weight: 400;
	}
	.detail {
		color: var(--cl-text-muted);
		font: var(--cl-caption);
	}
</style>
