<!--
@component Figure: the four line drawings that explain how Colander decides. Code-drawn SVG in
the text color: 1.5 px strokes, dots as nodes, a 2.5 px stroke for the main path, no color.
Fig. 1 to 3 are 360x200; Fig. 4 is 440x220 and sits on the band. Each is role="img" with a
sentence that says what it shows.
-->
<script lang="ts">
	import { LAYER_WORD } from '@colander/shared';

	let { n, list = 'Core list' }: { n: 1 | 2 | 3 | 4; list?: string } = $props();

	const uid = $props.id();
	const LABEL = $derived({
		1: 'Items with AI evidence pass through the rim into a bowl where the three tests apply. Items without AI evidence rest on the rim and are never slop.',
		2: 'Four rings for the four evidence layers. Two of them overlap, and only that overlap, where two layers agree, can be hidden.',
		3: 'A stack of tags stops at a dashed line. Past it, Slop also needs AI evidence and a mass-produced source.',
		4: `The signed list travels to your device, which matches your feed against it there. ${list}.`
	});
	const sparkle = (x: number, y: number) => `M${x} ${y - 5}L${x + 1.4} ${y - 1.4}L${x + 5} ${y}L${x + 1.4} ${y + 1.4}L${x} ${y + 5}L${x - 1.4} ${y + 1.4}L${x - 5} ${y}L${x - 1.4} ${y - 1.4}Z`;
	const tag = (x: number, y: number) => `M${x} ${y}h44l14 14l-14 14h-44z`;
</script>

<svg
	class="fig"
	viewBox={n === 4 ? '0 0 440 220' : '0 0 360 200'}
	width={n === 4 ? 440 : 360}
	height={n === 4 ? 220 : 200}
	role="img"
	aria-label={LABEL[n]}
>
	{#if n === 1}
		<!-- Plain dots resting on the rim. -->
		<g class="node-o">
			<circle cx="62" cy="81" r="7" /><circle cx="84" cy="81" r="7" /><circle cx="276" cy="81" r="7" /><circle cx="298" cy="81" r="7" />
		</g>
		<text x="24" y="40" class="lbl">No AI evidence,</text>
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
	{:else if n === 2}
		<defs>
			<clipPath id="{uid}-b"><circle cx="154" cy="128" r="34" /></clipPath>
			<pattern id="{uid}-ink" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.5" class="fill" /></pattern>
		</defs>
		<g class="ring">
			<circle cx="68" cy="52" r="28" />
			<circle cx="292" cy="52" r="28" />
			<circle cx="154" cy="128" r="34" />
			<circle cx="198" cy="128" r="34" />
		</g>
		<circle cx="198" cy="128" r="34" clip-path="url(#{uid}-b)" fill="url(#{uid}-ink)" />
		<text x="68" y="100" class="lbl" text-anchor="middle">{LAYER_WORD.provenance}</text>
		<text x="292" y="100" class="lbl" text-anchor="middle">{LAYER_WORD.consensus}</text>
		<text x="112" y="132" class="lbl" text-anchor="end">{LAYER_WORD.behavior}</text>
		<text x="240" y="132" class="lbl">{LAYER_WORD.rubric}</text>
		<path class="main" d="M176 166V176" />
		<text x="176" y="194" class="lbl strong" text-anchor="middle">Two agree: can be hidden</text>
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
		<text x="280" y="186" class="lbl" text-anchor="middle">Mass-produced source</text>
	{:else}
		<!-- The signed list card. -->
		<rect x="8" y="56" width="128" height="96" rx="10" class="line" />
		<text x="22" y="80" class="lbl strong">{list}</text>
		<path class="line" d="M22 96H118M22 112H104M22 128H112" />
		<path class="main" d="M144 104H184" /><path class="line" d="M178 98L184 104L178 110" />
		<!-- The device. -->
		<rect x="194" y="62" width="64" height="84" rx="10" class="line" />
		<path class="line" d="M214 136H238" />
		<g class="node"><circle cx="214" cy="100" r="3" /><circle cx="226" cy="100" r="3" /><circle cx="238" cy="100" r="3" /></g>
		<path class="main" d="M266 104H306" /><path class="line" d="M300 98L306 104L300 110" />
		<!-- The feed of 3 cards. -->
		<rect x="316" y="44" width="116" height="32" rx="6" class="line" />
		<rect x="316" y="88" width="116" height="32" rx="6" class="line" />
		<rect x="316" y="132" width="116" height="32" rx="6" class="line dash" />
		<g class="node"><circle cx="332" cy="60" r="3" /><circle cx="332" cy="104" r="3" /></g>
		<path class="line" d="M344 60H412M344 104H400M332 148H412" />
		<text x="72" y="182" class="lbl" text-anchor="middle">Signed list</text>
		<text x="226" y="182" class="lbl" text-anchor="middle">Your device</text>
		<text x="374" y="194" class="lbl" text-anchor="middle">Your feed</text>
	{/if}
</svg>

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
		font: 600 12px/16px var(--cl-font);
		letter-spacing: 0.02em;
	}
	.strong {
		fill: currentColor;
	}
</style>
