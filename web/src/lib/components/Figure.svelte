<!--
@component Figure: the four line drawings that explain how Colander decides. Code-drawn SVG in
the text color: 1.5 px strokes, dots as nodes, a 2.5 px stroke for the main path, no color.
Fig. 1 to 3 are 360x200; Fig. 4 is 440x220 and sits on the band. Each is role="img" with a
sentence that says what it shows. Labels are 15 units, sized for the narrowest place each figure
renders, so none is set below 12 px: Figs. 1 to 3 render at 288 px and up (a 320 screen). Phones
get Fig. 4 redrawn on 300 units, as 440 units would set its labels below 12 px there.
-->
<script lang="ts">
	import { LAYER_WORD } from '@colander/shared';

	let { n }: { n: 1 | 2 | 3 | 4 } = $props();

	const uid = $props.id();
	const LABEL = {
		1: 'Four rings for the four evidence layers, in a cluster. Two of them overlap at the center, and only that overlap, where two layers agree, can be hidden.',
		2: 'Items with AI evidence pass through the rim into a bowl where the three tests apply. Items without AI evidence rest on the rim and are never slop.',
		3: 'A stack of tags stops at a dashed line. Past it, Slop also needs AI evidence and a mass-produced source.',
		4: 'The signed list travels to your device, which matches your feed against it there.'
	};
	const sparkle = (x: number, y: number) => `M${x} ${y - 5}L${x + 1.4} ${y - 1.4}L${x + 5} ${y}L${x + 1.4} ${y + 1.4}L${x} ${y + 5}L${x - 1.4} ${y + 1.4}L${x - 5} ${y}L${x - 1.4} ${y - 1.4}Z`;
	const tag = (x: number, y: number) => `M${x} ${y}h44l14 14l-14 14h-44z`;
</script>

<svg
	class="fig"
	class:fig4={n === 4}
	class:wide={n === 4}
	viewBox={n === 4 ? '0 0 440 220' : '0 0 360 200'}
	width={n === 4 ? 440 : 360}
	height={n === 4 ? 220 : 200}
	role="img"
	aria-label={LABEL[n]}
>
	{#if n === 1}
		<!-- A 2 by 2 cluster: the agreeing pair overlaps at the center, and every label sits outside
		     its ring, on the cluster's outer side. -->
		<defs>
			<clipPath id="{uid}-b"><circle cx="162" cy="124" r="30" /></clipPath>
			<pattern id="{uid}-ink" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.5" class="fill" /></pattern>
		</defs>
		<g class="ring">
			<circle cx="132" cy="50" r="30" />
			<circle cx="228" cy="50" r="30" />
			<circle cx="162" cy="124" r="30" />
			<circle cx="198" cy="124" r="30" />
		</g>
		<circle cx="198" cy="124" r="30" clip-path="url(#{uid}-b)" fill="url(#{uid}-ink)" />
		{#each LAYER_WORD.provenance.split(' ') as word, i (i)}<text x="94" y={55 + i * 17} class="lbl" text-anchor="end">{word}</text>{/each}
		{#each LAYER_WORD.consensus.split(' ') as word, i (i)}<text x="266" y={46 + i * 17} class="lbl">{word}</text>{/each}
		{#each LAYER_WORD.behavior.split(' ') as word, i (i)}<text x="124" y={120 + i * 17} class="lbl" text-anchor="end">{word}</text>{/each}
		{#each LAYER_WORD.rubric.split(' ') as word, i (i)}<text x="236" y={120 + i * 17} class="lbl">{word}</text>{/each}
		<path class="main" d="M180 156V168" />
		<text x="180" y="188" class="lbl strong" text-anchor="middle">Two agree: can be hidden</text>
	{:else if n === 2}
		<!-- Plain dots resting on the rim. -->
		<g class="node-o">
			<circle cx="62" cy="81" r="7" /><circle cx="84" cy="81" r="7" /><circle cx="276" cy="81" r="7" /><circle cx="298" cy="81" r="7" />
		</g>
		<text x="24" y="38" class="lbl">No AI evidence,</text>
		<text x="24" y="56" class="lbl">never slop</text>
		<path class="line" d="M70 62V72" />
		<!-- The rim, open at two gaps, and the bowl below it. -->
		<path class="main" d="M24 90H160M178 90H196M214 90H336" />
		<path class="line" d="M64 90Q76 176 187 176Q298 176 310 90" />
		<!-- Items with AI evidence: a dot and a small sparkle, falling through the gaps. -->
		<g class="node">
			<circle cx="169" cy="26" r="6" /><circle cx="205" cy="44" r="6" /><circle cx="169" cy="122" r="6" /><circle cx="205" cy="136" r="6" />
		</g>
		<path class="spark" d="{sparkle(180, 18)} {sparkle(216, 36)} {sparkle(180, 114)} {sparkle(216, 128)}" />
		<path class="line dash" d="M169 36V108M205 54V122" />
		<text x="187" y="164" class="lbl" text-anchor="middle">Three tests</text>
	{:else if n === 3}
		<!-- A stack of tags that stops at the line. -->
		<g class="line">
			<path d={tag(28, 52)} /><path d={tag(36, 72)} /><path d={tag(44, 92)} /><path d={tag(52, 112)} />
		</g>
		<g class="node"><circle cx="40" cy="66" r="3" /><circle cx="48" cy="86" r="3" /><circle cx="56" cy="106" r="3" /><circle cx="64" cy="126" r="3" /></g>
		<text x="62" y="170" class="lbl" text-anchor="middle">Tags</text>
		<path class="main" d="M118 100H150" />
		<path class="line" d="M150 92V108" />
		<path class="line dash" d="M168 16V184" />
		<!-- The slot, which needs two more inputs. -->
		<rect x="232" y="78" width="96" height="44" rx="10" class="line" />
		<text x="280" y="105" class="lbl strong" text-anchor="middle">Slop</text>
		<path class="main" d="M280 42V72M280 158V128" />
		<g class="node"><circle cx="280" cy="38" r="4" /><circle cx="280" cy="162" r="4" /></g>
		<text x="280" y="26" class="lbl" text-anchor="middle">AI evidence</text>
		<text x="264" y="186" class="lbl" text-anchor="middle">Mass-produced source</text>
	{:else}
		<!-- The signed list card and its name. -->
		<rect x="4" y="48" width="160" height="112" rx="10" class="line" />
		<text x="18" y="74" class="lbl strong">Core list</text>
		<path class="line" d="M18 98H146M18 114H124M18 130H136M18 146H112" />
		<path class="main" d="M170 104H196" /><path class="line" d="M190 98L196 104L190 110" />
		<!-- The device. -->
		<rect x="202" y="62" width="56" height="84" rx="10" class="line" />
		<path class="line" d="M218 136H242" />
		<g class="node"><circle cx="218" cy="100" r="3" /><circle cx="230" cy="100" r="3" /><circle cx="242" cy="100" r="3" /></g>
		<path class="main" d="M264 104H300" /><path class="line" d="M294 98L300 104L294 110" />
		<!-- The feed: 3 cards, closed up, with nothing in place of what was hidden. -->
		<rect x="308" y="44" width="128" height="32" rx="6" class="line" />
		<rect x="308" y="88" width="128" height="32" rx="6" class="line" />
		<rect x="308" y="132" width="128" height="32" rx="6" class="line" />
		<g class="node"><circle cx="324" cy="60" r="3" /><circle cx="324" cy="104" r="3" /><circle cx="324" cy="148" r="3" /></g>
		<path class="line" d="M336 60H416M336 104H404M336 148H420" />
		<text x="84" y="190" class="lbl" text-anchor="middle">Signed list</text>
		<text x="230" y="190" class="lbl" text-anchor="middle">Your device</text>
		<text x="372" y="190" class="lbl" text-anchor="middle">Your feed</text>
	{/if}
</svg>
{#if n === 4}
	<!-- Phones: the same drawing on 300 units, so its labels stay at 12 px and up down to a 320 screen. -->
	<svg class="fig narrow" viewBox="0 0 300 160" width="300" height="160" role="img" aria-label={LABEL[4]}>
		<rect x="4" y="32" width="92" height="88" rx="10" class="line" />
		<text x="14" y="54" class="lbl strong">Core list</text>
		<path class="line" d="M14 90H84M14 104H72" />
		<path class="main" d="M102 76H120" /><path class="line" d="M115 71L120 76L115 81" />
		<rect x="126" y="40" width="48" height="72" rx="10" class="line" />
		<path class="line" d="M140 102H160" />
		<g class="node"><circle cx="140" cy="72" r="3" /><circle cx="150" cy="72" r="3" /><circle cx="160" cy="72" r="3" /></g>
		<path class="main" d="M180 76H198" /><path class="line" d="M193 71L198 76L193 81" />
		<rect x="204" y="28" width="92" height="26" rx="6" class="line" />
		<rect x="204" y="63" width="92" height="26" rx="6" class="line" />
		<rect x="204" y="98" width="92" height="26" rx="6" class="line" />
		<g class="node"><circle cx="216" cy="41" r="3" /><circle cx="216" cy="76" r="3" /><circle cx="216" cy="111" r="3" /></g>
		<path class="line" d="M226 41H284M226 76H274M226 111H280" />
		<text x="50" y="148" class="lbl" text-anchor="middle">Signed list</text>
		<text x="150" y="148" class="lbl" text-anchor="middle">Your device</text>
		<text x="250" y="148" class="lbl" text-anchor="middle">Your feed</text>
	</svg>
{/if}

<style>
	.fig {
		display: block;
		width: 100%;
		max-width: 100%;
		height: auto;
		color: var(--cl-text);
		overflow: visible;
	}
	.line,
	.ring,
	.main,
	.node-o {
		fill: none;
		stroke: currentColor;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.line,
	.node-o {
		stroke-width: 1.5;
	}
	.main {
		stroke-width: 2.5;
	}
	.ring {
		stroke-width: 3;
		stroke-dasharray: 0 7;
	}
	.dash {
		stroke-dasharray: 4 5;
	}
	.node,
	.fill,
	.spark {
		fill: currentColor;
	}
	.lbl {
		fill: var(--cl-text-muted);
		font: 600 15px/18px var(--cl-font);
		letter-spacing: 0.02em;
	}
	.narrow {
		display: none;
	}
	@media (max-width: 639px) {
		.wide {
			display: none;
		}
		.narrow {
			display: block;
		}
	}
	.strong {
		fill: currentColor;
	}
</style>
