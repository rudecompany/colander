<script lang="ts">
	import {
		ACTION_TABLE,
		SIGNAL_TEXT,
		SLOP_TYPES,
		SLOP_TYPE_WORD,
		STRICTNESS,
		STRICTNESS_HINT,
		STRICTNESS_WORD,
		TAG_WORD,
		VerdictChip,
		type Action,
		type Verdict
	} from '@colander/shared';
	import PageHead from '#lib/components/PageHead.svelte';
	import { LAYER_KEYS, LAYER_QUESTION, LAYER_SIGNALS, LAYER_WORD } from '#lib/layers.ts';

	const toc = [
		['definition', 'The working definition'],
		['not-slop', 'What is not slop'],
		['types', 'Three types'],
		['detectors', 'Why not an AI detector'],
		['layers', 'Four evidence layers'],
		['verdicts', 'Verdicts'],
		['strictness', 'Strictness levels'],
		['safeguards', 'Safeguards'],
		['consensus', 'How consensus works'],
		['rubric', 'The tagging rubric'],
		['appeals', 'Appeals'],
		['sources', 'Sources']
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

	const verdictRows: { v: Verdict; evidence: string; action: string }[] = [
		{ v: 'slop', evidence: 'AI evidence, plus a mass-produced source, plus community consensus or staff review', action: 'Hide' },
		{ v: 'likely_slop', evidence: 'AI evidence, plus behavior or rubric signals, with consensus still forming', action: 'Collapse, with the reason shown' },
		{ v: 'ai_made', evidence: 'AI evidence only', action: 'Label' },
		{ v: 'disputed', evidence: 'Tags and counter-tags split, or an appeal is open', action: 'Show, with a disputed mark' },
		{ v: 'clear', evidence: '"Not slop" consensus or a successful appeal', action: 'Allow' }
	];

	const ACTION_WORD: Record<Action, string> = { hide: 'Hide', collapse: 'Collapse', label: 'Label', allow: 'Allow' };

	const sources = [
		['Kommers et al., "Why Slop Matters", ACM AI Letters, March 2026', 'https://doi.org/10.1145/3786777', 'Three family-resemblance features: superficial competence, asymmetric effort and mass producibility.'],
		['Silbey and Hartzog, "AI Slop", September 2026', 'https://cyberlaw.stanford.edu/publications/ai-slop/', 'Negligible exertion, asymmetrical imposition and domain degradation, scored along a spectrum.'],
		['Shaib et al., "Measuring AI Slop in Text", 2025', 'https://arxiv.org/abs/2509.19163', 'Information utility, information quality and style quality. Not all AI text is slop.'],
		['Columbia IGP, "AI Slop and the Information Ecosystem", June 2026', 'https://igp.sipa.columbia.edu/sites/igp/files/2026-06/AI%20Slop%20and%20the%20Information%20Ecosystem_IGP%20Report.pdf', 'Slop as a high-volume subset of AI content, between benign and deliberately harmful.'],
		['Madsen and Puyt, "The 7Vs of AI Slop", 2025', 'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5558018', 'Seven dimensions, including volume and velocity.'],
		['Deepfake-Eval-2024 benchmark', 'https://arxiv.org/abs/2503.02857v1', 'Open-source detectors lose about half their accuracy on real social media.'],
		['Liang et al., 2023', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC10382961/', 'Seven detectors flagged 61.3% of essays by non-native English writers as AI-written.'],
		['Kagi SlopStop', 'https://help.kagi.com/kagi/features/slopstop.html', 'The 80% rule for sources, and item labels for mixed sources.'],
		['Community Notes bridging', 'https://arxiv.org/pdf/2512.19947', 'Agreement between people who usually disagree.'],
		['SponsorBlock', 'https://web.sponsor.ajay.app/about', 'Random per-install IDs, votes and reputation instead of accounts.']
	];
</script>

<svelte:head>
	<title>The definition of AI slop · Colander</title>
	<meta name="description" content="The published definition of AI slop that Colander uses, with its three tests, four evidence layers, five verdicts and the tagging rubric." />
</svelte:head>

<PageHead
	eyebrow="The definition"
	title="What counts as AI slop, and how Colander decides"
	lede="Researchers agree there is no consensus definition, so Colander publishes a working one, built from the frameworks that recur across the literature. Every verdict is measured against this page."
/>

<div class="wrap layout">
	<nav class="toc" aria-label="On this page">
		<p class="toc-title">On this page</p>
		<ol>
			{#each toc as [id, label] (id)}<li><a href="#{id}">{label}</a></li>{/each}
		</ol>
	</nav>

	<article class="prose doc">
		<section id="definition">
			<h2>The working definition</h2>
			<p class="lead">
				AI slop is AI-generated content that is mass-produced with little human effort to capture attention or money, and
				that gives the viewer little in return. AI use alone never makes something slop.
			</p>
			<p>An item or source is slop when it is AI-generated and meets at least two of three tests.</p>
			<div class="table-scroll">
				<table class="plain stack-sm">
					<thead><tr><th scope="col">Test</th><th scope="col">Question</th><th scope="col">Research root</th></tr></thead>
					<tbody>
						{#each tests as [name, q, root] (name)}
							<tr><th scope="row" class="strong">{name}</th><td>{q}</td><td class="muted" data-label="Research root">{root}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p>
				The unit that matters most is the source: the channel, profile or page. Slop is a production pattern, and patterns
				show at the source level long before a single item gives itself away.
			</p>
		</section>

		<section id="not-slop">
			<h2>What is not slop</h2>
			<ul>
				<li>AI-assisted work with clear human authorship, such as AI used for editing, captions, dubbing or illustration.</li>
				<li>Openly artificial art, satire, parody and political expression, which have real expressive and dissent value.</li>
				<li>Low-quality human-made content. It may be bad, but it is out of scope.</li>
				<li>
					Deepfakes, fraud and intimate-image abuse. These are harms beyond slop and belong with platform and legal
					reporting. The extension offers a shortcut to the platform's own reporting.
				</li>
			</ul>
		</section>

		<section id="types">
			<h2>Three types you can tag</h2>
			<div class="table-scroll">
				<table class="plain stack-sm">
					<thead><tr><th scope="col">Type</th><th scope="col">What it is</th><th scope="col">Example</th></tr></thead>
					<tbody>
						{#each SLOP_TYPES as t (t)}
							<tr><th scope="row" class="strong">{SLOP_TYPE_WORD[t]}</th><td>{types[t][0]}</td><td class="muted" data-label="Example">{types[t][1]}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p>Deceptive slop is hidden first. Openly artificial, expressive work is labeled, not hidden.</p>
		</section>

		<section id="detectors">
			<h2>Why an AI detector cannot be the method</h2>
			<ul>
				<li>Open-source detectors lose about half their accuracy on real social media. On one benchmark, accuracy fell 50% for video, 48% for audio and 45% for images.</li>
				<li>Text detectors punish the wrong people. Seven detectors flagged 61.3% of essays by non-native English writers as AI-written.</li>
				<li>Detecting AI is not detecting slop. They are different tasks, and standard automatic measures did not reproduce editors' judgments.</li>
				<li>Labels and watermarks can be stripped, covered or never applied.</li>
			</ul>
			<p>
				Detector models are therefore optional, run on your device, and can only add weight to the "AI-made" question. They
				can never mark something as slop.
			</p>
		</section>

		<section id="layers">
			<h2>The four evidence layers</h2>
			<p>No single signal hides anything. Each source and item is scored from four layers, and nothing is hidden by default until two independent layers agree.</p>
			<ol class="layer-list">
				{#each LAYER_KEYS as k, i (k)}
					<li class="card">
						<p class="layer-head"><span class="layer-n cl-num">{i + 1}</span> {LAYER_WORD[k]}</p>
						<p class="strong">{LAYER_QUESTION[k]}</p>
						<ul class="signals">
							{#each LAYER_SIGNALS[k] as s (s)}<li>{SIGNAL_TEXT[s]}</li>{/each}
						</ul>
					</li>
				{/each}
			</ol>
		</section>

		<section id="verdicts">
			<h2>Five verdicts</h2>
			<div class="table-scroll">
				<table class="plain stack-sm">
					<thead><tr><th scope="col">Verdict</th><th scope="col">Evidence required</th><th scope="col">Default action</th></tr></thead>
					<tbody>
						{#each verdictRows as r (r.v)}
							<tr><th scope="row"><VerdictChip verdict={r.v} /></th><td data-label="Evidence">{r.evidence}</td><td data-label="On Standard">{r.action}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p>The actions shown are those of the Standard level. Labels describe content, never the people who made it.</p>
		</section>

		<section id="strictness">
			<h2>Strictness levels</h2>
			<div class="table-scroll">
				<table class="plain stack-sm">
					<thead>
						<tr>
							<th scope="col">Level</th>
							<th scope="col"><VerdictChip verdict="slop" /></th>
							<th scope="col"><VerdictChip verdict="likely_slop" /></th>
							<th scope="col"><VerdictChip verdict="ai_made" /></th>
							<th scope="col">What it does</th>
						</tr>
					</thead>
					<tbody>
						{#each STRICTNESS as s (s)}
							<tr>
								<th scope="row" class="strong">{STRICTNESS_WORD[s]}{s === 'standard' ? ' (default)' : ''}</th>
								<td data-label="Slop">{ACTION_WORD[ACTION_TABLE[s].slop]}</td>
								<td data-label="Likely slop">{ACTION_WORD[ACTION_TABLE[s].likely_slop]}</td>
								<td data-label="AI-made">{ACTION_WORD[ACTION_TABLE[s].ai_made]}</td>
								<td class="muted">{STRICTNESS_HINT[s]}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p>Disputed items are always shown with a mark, and Clear items are always allowed.</p>
		</section>

		<section id="safeguards">
			<h2>Safeguards against wrong calls</h2>
			<ol>
				<li>AI evidence is a gate. Without it, nothing can be rated slop, however low its quality.</li>
				<li>Two layers must agree before anything is hidden by default.</li>
				<li>Mixed sources are never hidden as a whole. Their AI items get item-level labels.</li>
				<li>Sources with large audiences need staff review before a list-wide Slop verdict.</li>
				<li>Every hidden item states which signals fired, and one click reveals it.</li>
				<li>Source verdicts expire and are re-scored every 90 days. An appeal triggers re-review at once.</li>
			</ol>
			<p>
				A source counts as mostly AI when at least 80% of its recent items carry AI evidence, following Kagi's published
				rule. Other thresholds are starting values, calibrated against a hand-labeled set of at least 1,000 sources.
			</p>
		</section>

		<section id="consensus">
			<h2>How consensus is computed</h2>
			<p>
				Each install gets a random pseudonymous ID. A tag applies on the tagger's own device at once and enters the shared
				pool with a weight based on that tagger's track record. New installs count for little, and bursts of tags on one
				source from new installs freeze its consensus until staff look.
			</p>
			<p>
				Paying or donating never changes tag weight, review priority or any verdict. Bridging, where a verdict needs agreement
				between groups that usually tag differently, is added once tag volume supports it.
			</p>
		</section>

		<section id="rubric">
			<h2>The tagging rubric</h2>
			<p>Tagging takes two clicks, on the content itself. You choose one of three tags.</p>
			<ul>
				<li><strong>{TAG_WORD.slop}.</strong> Optionally add a type (Filler, Bait or Deceptive) and tick which of the three tests apply.</li>
				<li><strong>{TAG_WORD.ai_fine}.</strong> AI-generated, and fine. This counts toward the AI-made question only.</li>
				<li><strong>{TAG_WORD.not_slop}.</strong> A counter-tag. Enough of them move a verdict to Disputed or Clear.</li>
			</ul>
			<p>When you tick tests, ask three questions about the item.</p>
			<ul>
				<li><strong>Useful.</strong> Would a viewer come away knowing or feeling something they came for?</li>
				<li><strong>Accurate.</strong> Are the facts, dates, names and images right?</li>
				<li><strong>Original.</strong> Is there footage, commentary or judgment you would not find on ten other sources?</li>
			</ul>
			<p class="callout">
				AI voices, dubbing and translation are not evidence of slop on their own. Many creators who are non-native speakers
				or disabled rely on them.
			</p>
		</section>

		<section id="appeals">
			<h2>Appeals</h2>
			<p>
				Every label links to a public page for its source, showing the verdict and the evidence behind it. A creator who
				disagrees can appeal from that page.
			</p>
			<ol>
				<li>Start an appeal from the source page with an email address and a short statement.</li>
				<li>Prove control of the account by adding a short code to its description or bio, then choose Verify.</li>
				<li>Once verified, the verdict changes to Disputed and nothing from the source is hidden while staff review.</li>
				<li>The outcome and the reasoning are published in the <a href="/log">decision log</a>.</li>
			</ol>
			<p>Unverified appeals expire after 14 days. Appeal pages never ask for money.</p>
		</section>

		<section id="sources">
			<h2>Sources</h2>
			<ul class="sources">
				{#each sources as [name, href, note] (href)}
					<li><a {href} rel="noreferrer">{name}</a><span class="muted">{note}</span></li>
				{/each}
			</ul>
			<p class="muted t-body">Version 1, October 2026. Changes to this definition are published on this page with their date.</p>
		</section>
	</article>
</div>

<style>
	.layout {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		gap: 64px;
		padding-top: var(--cl-s6);
	}
	.toc {
		position: sticky;
		top: 24px;
		align-self: start;
		font: var(--cl-body);
	}
	.toc-title {
		font-weight: 600;
		color: var(--cl-text-muted);
		margin-bottom: var(--cl-s2);
	}
	.toc ol {
		list-style: none;
		display: grid;
		gap: 2px;
		border-left: 1px solid var(--cl-border);
	}
	.toc a {
		display: block;
		padding: 4px 0 4px 14px;
		margin-left: -1px;
		border-left: 2px solid transparent;
		color: var(--cl-text-muted);
		text-decoration: none;
	}
	.toc a:hover {
		color: var(--cl-text);
		border-left-color: var(--cl-text);
	}
	.doc {
		max-width: 760px;
	}
	.doc section {
		padding-bottom: var(--cl-s5);
	}
	.doc section + section {
		padding-top: var(--cl-s5);
		border-top: 1px solid var(--cl-border);
	}
	.doc section > :global(* + *) {
		margin-top: var(--cl-s4);
	}
	.doc h2 {
		margin-top: 0;
	}
	.lead {
		font: 400 20px/30px var(--cl-font);
		padding-left: var(--cl-s4);
		border-left: 3px solid var(--cl-text);
	}
	.strong {
		font-weight: 600;
		color: var(--cl-text);
	}
	th.strong {
		white-space: nowrap;
	}
	.layer-list {
		list-style: none;
		padding: 0 !important;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--cl-s3);
	}
	.layer-list li {
		margin: 0 !important;
		display: grid;
		gap: var(--cl-s2);
		align-content: start;
		padding: var(--cl-s4);
	}
	.layer-head {
		display: flex;
		align-items: center;
		gap: 10px;
		font: var(--cl-title);
	}
	.layer-n {
		display: inline-grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 1.5px solid var(--cl-text);
		font: 700 13px/1 var(--cl-font);
	}
	.signals {
		font: var(--cl-body);
		color: var(--cl-text-muted);
		padding-left: 18px !important;
	}
	.signals li + li {
		margin-top: 2px !important;
	}
	.callout {
		padding: var(--cl-s3) var(--cl-s4);
		border-radius: var(--cl-r-card);
		background: var(--cl-surface-raised);
		border: 1px solid var(--cl-border);
		font: var(--cl-body);
	}
	.sources {
		list-style: none;
		padding: 0 !important;
		font: var(--cl-body);
	}
	.sources li {
		display: grid;
		gap: 2px;
	}
	.sources li + li {
		margin-top: var(--cl-s3) !important;
	}
	@media (max-width: 960px) {
		.layout {
			grid-template-columns: 1fr;
			gap: 0;
		}
		.toc {
			display: none;
		}
	}
	@media (max-width: 600px) {
		.layer-list {
			grid-template-columns: 1fr;
		}
	}
</style>
