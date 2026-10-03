<script lang="ts">
	import {
		ACTION_DONE_WORD,
		ACTION_TABLE,
		DEFINITION,
		LAYER_KEYS,
		LAYER_QUESTION,
		LAYER_SIGNALS,
		LAYER_WORD,
		PageHeader,
		SIGNAL_TEXT,
		SLOP_TYPES,
		SLOP_TYPE_WORD,
		StrictnessTable,
		TAG_WORD,
		VerdictChip,
		VERDICTS,
		fmtDate,
		type Verdict
	} from '@colander/shared';
	import ChevronsDownUp from '@lucide/svelte/icons/chevrons-down-up';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Tag from '@lucide/svelte/icons/tag';
	import Figure from '#lib/components/Figure.svelte';
	import { COMPARISON, COMPARISON_CHECKED } from '#lib/content.ts';

	const toc = [
		['definition', 'The definition'],
		['tests', 'The three tests'],
		['not-slop', 'What is not slop'],
		['types', 'Three types'],
		['layers', 'Four evidence layers'],
		['verdicts', 'Five verdicts'],
		['safeguards', 'Safeguards'],
		['strictness', 'Strictness'],
		['signing', 'How signing works'],
		['consensus', 'How consensus works'],
		['rubric', 'The tagging rubric'],
		['appeals', 'Appeals'],
		['detectors', 'Why not an AI detector'],
		['comparison', 'Comparison sources'],
		['sources', 'Research']
	] as const;

	const tests = [
		['Low effort', 'Is there little sign of human authorship, such as original footage, commentary, editing judgment or fact-checking?', 'Asymmetric effort, negligible exertion'],
		['Mass-produced', 'Does the source publish at a volume and sameness that points to an automated pipeline?', 'Mass producibility, volume, velocity'],
		['Hollow', 'Does it look competent while carrying little information, containing errors, or existing mainly to hold attention or push a link?', 'Superficial competence, information utility and quality']
	];

	const types = {
		filler: ['Generic content tuned for engagement, with no real subject and no next step', 'Surreal animal clips, endless AI "history" narration'],
		bait: ['Slop that routes the viewer to a link, product, install or scam', 'AI image posts with affiliate links in the comments'],
		deceptive: ['Synthetic content presented as real', 'Fabricated news events, staged rescue videos']
	};

	const EVIDENCE: Record<Verdict, string> = {
		slop: 'AI evidence, plus a mass-produced source, plus community consensus or staff review',
		likely_slop: 'AI evidence, plus behavior or rubric signals, with consensus still forming',
		ai_made: 'AI evidence only',
		disputed: 'Tags and counter-tags split, or an appeal is open',
		clear: '"Not slop" consensus or a successful appeal'
	};
	const ACTION_ICON = { hide: EyeOff, collapse: ChevronsDownUp, label: Tag, allow: Eye };

	const research = [
		['Kommers et al., "Why Slop Matters", ACM AI Letters, March 2026', 'https://doi.org/10.1145/3786777', 'Three family-resemblance features: superficial competence, asymmetric effort and mass producibility.'],
		['Silbey and Hartzog, "AI Slop", September 2026', 'https://cyberlaw.stanford.edu/publications/ai-slop/', 'Negligible exertion, asymmetrical imposition and domain degradation, scored along a spectrum.'],
		['Shaib et al., "Measuring AI Slop in Text", 2025', 'https://arxiv.org/abs/2509.19163', 'Information utility, information quality and style quality. Not all AI text is slop.'],
		['Columbia IGP, "AI Slop and the Information Ecosystem", June 2026', 'https://igp.sipa.columbia.edu/sites/igp/files/2026-06/AI%20Slop%20and%20the%20Information%20Ecosystem_IGP%20Report.pdf', 'Slop as a high-volume subset of AI content, between benign and deliberately harmful.'],
		['Madsen and Puyt, "The 7Vs of AI Slop", 2025', 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5558018', 'Seven dimensions, including volume and velocity.'],
		['Deepfake-Eval-2024 benchmark', 'https://arxiv.org/abs/2503.02857v1', 'Open-source detectors lose about half their accuracy on real social media.'],
		['Liang et al., 2023', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10382961/', 'Seven detectors misjudged 61.3% of essays by non-native English writers as AI-written.'],
		['Kagi SlopStop', 'https://help.kagi.com/kagi/features/slopstop.html', 'The 80% rule for sources, and item labels for mixed sources.'],
		['Community Notes bridging', 'https://arxiv.org/pdf/2512.19947', 'Agreement between people who usually disagree.'],
		['SponsorBlock', 'https://web.sponsor.ajay.app/about', 'Random per-install IDs, votes and reputation instead of accounts.']
	];
</script>

<svelte:head>
	<title>How Colander decides · Colander</title>
	<meta
		name="description"
		content="The published definition of AI slop that Colander uses: three tests, four evidence layers, five verdicts, the strictness levels, signing, consensus and appeals."
	/>
</svelte:head>

<div class="cl-container page-top">
	<PageHeader
		eyebrow="How it decides"
		title="How Colander decides"
		lede="Researchers agree there is no settled definition of AI slop, so Colander publishes a working one built from the frameworks that recur across the research. Every verdict is measured against this page."
	/>
</div>

{#snippet tocList()}
	<ol>
		{#each toc as [id, label] (id)}<li><a href="#{id}">{label}</a></li>{/each}
	</ol>
{/snippet}

<div class="cl-container page-body longform">
	<nav class="toc" aria-label="On this page">
		<p class="toc-title">On this page</p>
		{@render tocList()}
	</nav>

	<article class="doc">
		<details class="toc-mobile">
			<summary>On this page</summary>
			{@render tocList()}
		</details>

		<section id="definition" class="prose">
			<h2>The definition</h2>
			<p class="cl-title-lg statement">{DEFINITION}</p>
			<p>
				The unit that matters most is the source: the channel, profile or page. Slop is a production pattern, and patterns show at
				the source level long before a single item gives itself away.
			</p>
		</section>

		<section id="tests" class="prose">
			<h2>The three tests</h2>
			<p>An item or source is slop when it is AI-generated and meets at least two of three tests.</p>
			<div class="table-card">
				<table class="plain stack-sm">
					<thead><tr><th scope="col">Test</th><th scope="col">Question</th><th scope="col">Research root</th></tr></thead>
					<tbody>
						{#each tests as [name, q, root] (name)}
							<tr><th scope="row" class="nowrap">{name}</th><td>{q}</td><td class="muted" data-label="Research root">{root}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section id="not-slop" class="prose">
			<h2>What is not slop</h2>
			<ul class="dots-list">
				<li>AI-assisted work with clear human authorship, such as AI used for editing, captions, dubbing or illustration.</li>
				<li>Openly artificial art, satire, parody and political expression, which have real expressive and dissent value.</li>
				<li>Low-quality human-made content. It may be bad, but it is out of scope.</li>
				<li>
					Deepfakes, fraud and intimate-image abuse. These are harms beyond slop and belong with platform and legal reporting. The
					extension offers a shortcut to the platform's own reporting.
				</li>
			</ul>
		</section>

		<section id="types" class="prose">
			<h2>Three types you can tag</h2>
			<div class="table-card">
				<table class="plain stack-sm">
					<thead><tr><th scope="col">Type</th><th scope="col">What it is</th><th scope="col">Example</th></tr></thead>
					<tbody>
						{#each SLOP_TYPES as t (t)}
							<tr><th scope="row">{SLOP_TYPE_WORD[t]}</th><td>{types[t][0]}</td><td class="muted" data-label="Example">{types[t][1]}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p>Deceptive slop is hidden first. Openly artificial, expressive work is labeled, not hidden.</p>
		</section>

		<section id="layers" class="prose">
			<h2>The four evidence layers</h2>
			<p>
				No single signal hides anything. Each source and item is scored from four layers, and nothing is hidden by default until two
				independent layers agree.
			</p>
			<figure class="fig">
				<Figure n={2} />
				<figcaption><span class="cl-figure muted">Fig. 2</span> Two layers must agree.</figcaption>
			</figure>
			<ol class="layers">
				{#each LAYER_KEYS as k, i (k)}
					<li>
						<span class="cl-figure muted">0{i + 1}</span>
						<h3>{LAYER_WORD[k]}</h3>
						<p class="q">{LAYER_QUESTION[k]}</p>
						<ul class="dots-list">
							{#each LAYER_SIGNALS[k] as s (s)}<li>{SIGNAL_TEXT[s]}</li>{/each}
						</ul>
					</li>
				{/each}
			</ol>
		</section>

		<section id="verdicts" class="prose">
			<h2>Five verdicts</h2>
			<div class="table-card">
				<table class="plain stack-sm">
					<thead><tr><th scope="col">Verdict</th><th scope="col">Evidence required</th><th scope="col">At Standard</th></tr></thead>
					<tbody>
						{#each VERDICTS as v (v)}
							{@const a = ACTION_TABLE.standard[v]}
							{@const Icon = ACTION_ICON[a]}
							<tr>
								<th scope="row"><VerdictChip verdict={v} /></th>
								<td data-label="Evidence">{EVIDENCE[v]}</td>
								<td data-label="At Standard"><span class="act"><Icon size={16} aria-hidden="true" />{ACTION_DONE_WORD[a]}</span></td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p>Labels describe content, never the people who made it.</p>
		</section>

		<section id="safeguards" class="prose">
			<h2>Safeguards against wrong calls</h2>
			<div class="fig-pair">
				<figure class="fig">
					<Figure n={1} />
					<figcaption><span class="cl-figure muted">Fig. 1</span> AI evidence is a gate.</figcaption>
				</figure>
				<figure class="fig">
					<Figure n={3} />
					<figcaption><span class="cl-figure muted">Fig. 3</span> Tags alone never make anything Slop.</figcaption>
				</figure>
			</div>
			<ol>
				<li>AI evidence is a gate. Without it, nothing can be rated slop, however low its quality.</li>
				<li>Two layers must agree before anything is hidden by default.</li>
				<li>Tags alone never make anything Slop. Slop needs AI evidence, a mass-produced source, and consensus or staff review.</li>
				<li>Mixed sources are never hidden as a whole. Their AI items get item-level labels.</li>
				<li>Sources with large audiences need staff review before a list-wide Slop verdict.</li>
				<li>Every hidden item states which signals agreed, and one click shows it again.</li>
				<li>Source verdicts expire and are re-scored every 90 days. An appeal triggers re-review at once.</li>
			</ol>
			<p>
				A source counts as mostly AI when at least 80% of its recent items carry AI evidence, following Kagi's published rule. Other
				thresholds are starting values, calibrated against a hand-labeled set of at least 1,000 sources.
			</p>
		</section>

		<section id="strictness" class="prose">
			<h2>Strictness</h2>
			<p>You choose what each verdict does to your own feed. Standard is the default. Colander never decides what an adult may see.</p>
			<div class="wide"><StrictnessTable current="standard" /></div>
			<p>Disputed items are always labeled, and Clear items are always shown.</p>
		</section>

		<section id="signing" class="prose">
			<h2>How signing works</h2>
			<figure class="fig">
				<Figure n={4} />
				<figcaption><span class="cl-figure muted">Fig. 4</span> The signed list, your device, your feed.</figcaption>
			</figure>
			<p>
				Colander works like an ad blocker. Your extension downloads the whole core list, carrying no identifier at all, and matches
				every feed card against it on your device. Colander never asks a server about the page you are viewing.
			</p>
			<p>
				Each copy of the list is signed by Colander. The extension checks the signature before it uses a list, refuses any copy that
				was changed on the way, and keeps working from its last good copy, offline too. It looks for updates about once an hour.
			</p>
		</section>

		<section id="consensus" class="prose">
			<h2>How consensus works</h2>
			<p>
				Each install gets a random pseudonymous ID. A tag applies on the tagger's own device at once and enters the shared pool with a
				weight based on that tagger's track record. New installs count for little, and bursts of tags on one source from new installs
				freeze its consensus until staff look.
			</p>
			<p>
				Paying or giving never changes tag weight, review priority or any verdict. Bridging, where a verdict needs agreement between
				groups that usually tag differently, is added once tag volume supports it.
			</p>
		</section>

		<section id="rubric" class="prose">
			<h2>The tagging rubric</h2>
			<p>Tagging takes two clicks, on the content itself. You choose one of three tags.</p>
			<ul class="dots-list">
				<li><strong>{TAG_WORD.slop}.</strong> Optionally add a type (Filler, Bait or Deceptive) and tick which of the three tests apply.</li>
				<li><strong>{TAG_WORD.ai_fine}.</strong> AI-generated, and fine. This counts toward the AI-made question only.</li>
				<li><strong>{TAG_WORD.not_slop}.</strong> A counter-tag. Enough of them move a verdict to Disputed or Clear.</li>
			</ul>
			<p>When you tick tests, ask three questions about the item.</p>
			<ul class="dots-list">
				<li><strong>Useful.</strong> Would a viewer come away knowing or feeling something they came for?</li>
				<li><strong>Accurate.</strong> Are the facts, dates, names and images right?</li>
				<li><strong>Original.</strong> Is there footage, commentary or judgment you would not find on ten other sources?</li>
			</ul>
			<p class="callout">
				AI voices, dubbing and translation are not evidence of slop on their own. Many creators who are non-native speakers or disabled
				rely on them.
			</p>
		</section>

		<section id="appeals" class="prose">
			<h2>Appeals</h2>
			<p>
				Every label links to a public page for its source, showing the verdict and the evidence behind it. A creator who disagrees can
				appeal from that page. Appeals are free.
			</p>
			<ol>
				<li>Start an appeal from the source page with an email address and a short statement.</li>
				<li>Prove control of the account by adding a short code to its description or bio, then choose Verify.</li>
				<li>Once verified, the verdict changes to Disputed and nothing from the source is hidden while staff review.</li>
				<li>The outcome and the reasoning are published in the <a href="/log">decision log</a>.</li>
			</ol>
			<p>Unverified appeals expire after 14 days.</p>
		</section>

		<section id="detectors" class="prose">
			<h2>Why an AI detector cannot be the method</h2>
			<ul class="dots-list">
				<li>Open-source detectors lose about half their accuracy on real social media. On one benchmark, accuracy fell 50% for video, 48% for audio and 45% for images.</li>
				<li>Text detectors punish the wrong people. Seven detectors misjudged 61.3% of essays by non-native English writers as AI-written.</li>
				<li>Detecting AI is not detecting slop. They are different tasks, and standard automatic measures did not reproduce editors' judgments.</li>
				<li>Labels and watermarks can be stripped, covered or never applied.</li>
			</ul>
			<p>
				Detector models are therefore optional, run on your device, and can only add weight to the AI-made question. They can never
				mark something as slop.
			</p>
		</section>

		<section id="comparison" class="prose">
			<h2>Comparison sources</h2>
			<p>
				The comparison on the home page describes what is common among the most-installed AI content blockers, without naming them.
				These are the listings each row was checked against on {fmtDate(COMPARISON_CHECKED)}. They are checked again for every
				release.
			</p>
			<dl class="sources-list">
				{#each COMPARISON as row (row.check)}
					<div>
						<dt>{row.check}: {row.common}</dt>
						<dd>
							{#each row.sources as s, i (s.url)}{#if i > 0}{'; '}{/if}<a href={s.url} rel="noreferrer">{s.name}</a>{/each}
						</dd>
					</div>
				{/each}
			</dl>
		</section>

		<section id="sources" class="prose">
			<h2>Research</h2>
			<ul class="research">
				{#each research as [name, href, note] (href)}
					<li><a {href} rel="noreferrer">{name}</a><span class="muted">{note}</span></li>
				{/each}
			</ul>
			<p class="muted">Version 1, October 2026. Changes to this definition are published on this page with their date.</p>
		</section>
	</article>
</div>

<style>
	.doc {
		display: grid;
		gap: var(--cl-s7);
		min-width: 0;
	}
	.doc > section + section {
		padding-top: var(--cl-s7);
		border-top: 1px solid var(--cl-border);
	}
	.muted {
		color: var(--cl-text-muted);
	}
	.nowrap {
		white-space: nowrap;
	}
	.statement {
		text-wrap: pretty;
	}
	.fig {
		display: grid;
		gap: 12px;
		max-width: 440px;
	}
	.fig figcaption {
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	.fig-pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 24px;
	}
	.layers {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
		padding: 0;
		list-style: none;
	}
	.prose .layers > li {
		display: grid;
		align-content: start;
		gap: 8px;
		margin: 0;
		padding: 24px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
	}
	.layers h3 {
		margin: 0;
		font: var(--cl-title);
	}
	.q {
		font: var(--cl-body-strong);
	}
	.layers .dots-list {
		padding: 0;
		color: var(--cl-text-muted);
		font: var(--cl-body);
	}
	.prose .dots-list {
		padding-left: 0;
	}
	.act {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}
	.wide {
		max-width: none;
	}
	.wide :global(td svg) {
		flex: none;
	}
	.callout {
		padding: 12px 16px;
		border: 1px solid var(--cl-border);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface);
		font: var(--cl-body);
	}
	.sources-list {
		display: grid;
		gap: 16px;
		font: var(--cl-body);
	}
	.sources-list dt {
		font-weight: 600;
	}
	.research {
		display: grid;
		gap: 12px;
		padding: 0 !important;
		list-style: none;
		font: var(--cl-body);
	}
	.prose .research li {
		display: grid;
		gap: 2px;
		margin: 0;
	}
	@media (max-width: 639px) {
		.fig-pair,
		.layers {
			grid-template-columns: 1fr;
		}
	}
</style>
