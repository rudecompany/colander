<script lang="ts">
	import { PageHeader, PermissionsTable, PRIVACY_INSTALL_ID, PrivacyFacts } from '@colander/shared';

	const toc = [
		['facts', 'What leaves your device'],
		['permissions', 'Permissions'],
		['requests', 'Every request it makes'],
		['install-id', 'Install IDs'],
		['website', 'The website'],
		['appeals', 'Appeals'],
		['payments', 'Payments'],
		['retention', 'How long we keep it'],
		['contact', 'Your rights and contact']
	] as const;

	const requests = [
		['List downloads', 'GET /v1/list/snapshot, GET /v1/list/delta', 'Nothing that identifies you. Not even the install ID.', 'About once an hour'],
		['Adapter configuration', 'GET /v1/config/adapters', 'Nothing that identifies you.', 'With list downloads'],
		[
			'Tags',
			'POST /v1/tags',
			'Platform, whether it is an item or a source, its ID, your tag, the optional type and tests, whether the platform showed an AI label, the time, the extension version and your install ID.',
			'On each tag'
		],
		['Reports', 'POST /v1/reports', 'The source, up to three example items, your reason, and your install ID.', 'On each report'],
		['Report status', 'GET /v1/reports', 'Your install ID, to list your own reports.', 'On opening My reports'],
		['Trial', 'POST /v1/trial', 'Your install ID, so a trial is given once per install.', 'On starting a trial'],
		['Plan refresh and settings sync', 'POST /v1/entitlement/refresh, /v1/sync', 'Your signed plan token and your settings.', 'Plus only'],
		['Review queue', '/v1/review/*', 'Your reviewer token.', 'Curators and staff only']
	];
</script>

<svelte:head>
	<title>Privacy · Colander</title>
	<meta name="description" content="What the Colander extension and website send, what they never send, and how long we keep it." />
</svelte:head>

<div class="cl-container page-top">
	<PageHeader
		eyebrow="Privacy"
		title="Matching happens on your device."
		title2="Your browsing stays there."
		lede="Colander works like an ad blocker: it downloads a signed list and matches it on your device. This page lists everything that leaves your browser, and what never does."
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

		<section id="facts" class="prose">
			<h2 class="sr-only">What leaves your device, and what never does</h2>
			<PrivacyFacts />
		</section>

		<section id="permissions" class="prose">
			<h2>Permissions</h2>
			<p>Chrome asks you before Colander gets any of these. Site access is asked one platform at a time, for the platforms you choose.</p>
			<PermissionsTable />
		</section>

		<section id="requests" class="prose">
			<h2>Every request the extension makes</h2>
			<p>The extension makes exactly these requests, and no others.</p>
			<div class="table-card">
				<table class="plain stack-sm">
					<thead><tr><th scope="col">Request</th><th scope="col">What it carries</th><th scope="col">When</th></tr></thead>
					<tbody>
						{#each requests as [name, endpoint, carries, when] (name)}
							<tr>
								<th scope="row">{name}<span class="cl-figure endpoint">{endpoint}</span></th>
								<td data-label="Carries">{carries}</td>
								<td data-label="When">{when}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p>Matching against the list happens on your device, so blocking also works offline from the last copy.</p>
		</section>

		<section id="install-id" class="prose">
			<h2>Install IDs are pseudonymous</h2>
			<p>{PRIVACY_INSTALL_ID}</p>
			<p>
				The ID is sent only with your tags, reports and trial request. It lets your tags count with the weight your track record has
				earned without telling us who you are.
			</p>
			<p>
				Pseudonymous data is still personal data under laws such as the GDPR, so we treat it that way: we collect the minimum, keep it
				only as long as it is needed, and never combine it with other data to find out who you are.
			</p>
		</section>

		<section id="website" class="prose">
			<h2>The website</h2>
			<ul class="dots-list">
				<li>Pages load no third-party scripts, fonts or images. There are no analytics and no trackers.</li>
				<li>This site sets no cookies until you sign in, so there is no banner. The sign-in cookie lasts 30 days.</li>
				<li>Sign-in uses an emailed link that expires after 20 minutes and works once. We do not use passwords.</li>
				<li>Your display name appears in the decision log if you review, and on the supporters page only if you ask for credit.</li>
			</ul>
		</section>

		<section id="appeals" class="prose">
			<h2>Appeals</h2>
			<p>
				An appeal asks for an email address and your statement. We use the address only to send the appeal link and its outcome. The
				decision and its reasoning are published in the decision log. Your email address never is.
			</p>
		</section>

		<section id="payments" class="prose">
			<h2>Payments</h2>
			<p>
				Checkout runs on a hosted page from our payment provider, which handles card details and tax. We never see or store card
				numbers. We keep the record of your plan and its renewal date.
			</p>
		</section>

		<section id="retention" class="prose">
			<h2>How long we keep it</h2>
			<ul class="dots-list">
				<li>Tags and reports are kept while they count toward a verdict. Verdicts are re-scored every 90 days.</li>
				<li>Server logs never record request paths that contain item or source IDs together with an install hash.</li>
				<li>Unverified appeals expire after 14 days.</li>
				<li>Account data is kept until you ask us to delete it, apart from billing records the law requires us to keep.</li>
			</ul>
		</section>

		<section id="contact" class="prose">
			<h2>Your rights and contact</h2>
			<p>
				You can ask to see, correct, export or delete the data tied to your account or your install ID. Your extension's options page
				can export everything it stores locally. Write to the contact address on our Chrome Web Store listing, and we will answer
				within 30 days.
			</p>
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
	.prose .dots-list {
		padding-left: 0;
	}
	.endpoint {
		display: block;
		margin-top: 4px;
		color: var(--cl-text-muted);
		font-weight: 600;
		overflow-wrap: anywhere;
	}
</style>
