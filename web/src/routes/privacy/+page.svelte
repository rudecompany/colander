<script lang="ts">
	import PageHead from '#lib/components/PageHead.svelte';
</script>

<svelte:head>
	<title>Privacy · Colander</title>
	<meta name="description" content="What the Colander extension and website send, what they never send, and how long we keep it." />
</svelte:head>

<PageHead
	eyebrow="Privacy"
	title="Your browsing stays on your device"
	lede="Colander works like an ad blocker: it downloads a signed list and matches it on your device. This page lists everything that leaves your browser, and what never does."
	narrow
/>

<div class="wrap wrap-narrow">
	<article class="prose doc">
		<section>
			<h2>The short version</h2>
			<ul>
				<li>No account is needed to block, tag, report or appeal.</li>
				<li>The extension never sends the pages you visit, your account names on other sites, or your watch history.</li>
				<li>Tags and reports carry a random install ID, not your name. We store only a one-way hash of it.</li>
				<li>No ads, no trackers, no analytics, and no sale or sharing of data.</li>
			</ul>
		</section>

		<section>
			<h2>What the extension sends</h2>
			<p>The extension makes exactly these requests, and no others.</p>
			<div class="table-scroll">
				<table class="plain stack-sm">
					<thead><tr><th scope="col">Request</th><th scope="col">What it carries</th><th scope="col">When</th></tr></thead>
					<tbody>
						<tr><th scope="row">List downloads</th><td data-label="Carries">Nothing that identifies you. Not even the install ID.</td><td data-label="When">About once an hour</td></tr>
						<tr><th scope="row">Adapter configuration</th><td data-label="Carries">Nothing that identifies you.</td><td data-label="When">With list downloads</td></tr>
						<tr>
							<th scope="row">Tags</th>
							<td data-label="Carries">Platform, whether it is an item or a source, its ID, your tag, the optional type and tests, whether the platform showed an AI label, the time, the extension version and your install ID.</td>
							<td data-label="When">When you tag</td>
						</tr>
						<tr><th scope="row">Reports</th><td data-label="Carries">The source, up to three example items, your reason, and your install ID.</td><td data-label="When">When you report a source</td></tr>
						<tr><th scope="row">Report status</th><td data-label="Carries">Your install ID, to list your own reports.</td><td data-label="When">When you open My reports</td></tr>
						<tr><th scope="row">Trial</th><td data-label="Carries">Your install ID, so a trial is given once per install.</td><td data-label="When">When you start a trial</td></tr>
						<tr><th scope="row">Plan refresh and settings sync</th><td data-label="Carries">Your signed plan token and your settings.</td><td data-label="When">Plus only</td></tr>
						<tr><th scope="row">Review queue</th><td data-label="Carries">Your reviewer token.</td><td data-label="When">Curators and staff only</td></tr>
					</tbody>
				</table>
			</div>
		</section>

		<section>
			<h2>What it never sends</h2>
			<ul>
				<li>The address of any page you visit, or any list of pages.</li>
				<li>Your user name or account details on YouTube, TikTok, Instagram or Facebook.</li>
				<li>Your watch history, browsing history or what you were shown.</li>
				<li>Anything about items you did not choose to tag or report.</li>
			</ul>
			<p>Matching against the list happens on your device, so blocking also works offline from the last copy.</p>
		</section>

		<section>
			<h2>Install IDs are pseudonymous</h2>
			<p>
				On first run, the extension makes 16 random bytes. That ID is sent only with your tags, reports and trial request.
				Our server never stores it as it is: it keeps a one-way hash, which lets your tags count with the weight your
				track record has earned without telling us who you are.
			</p>
			<p>
				Pseudonymous data is still personal data under laws such as the GDPR, so we treat it that way: we collect the
				minimum, keep it only as long as it is needed, and never combine it with other data to find out who you are.
			</p>
		</section>

		<section>
			<h2>The website</h2>
			<ul>
				<li>Pages load no third-party scripts, fonts or images. There are no analytics and no trackers.</li>
				<li>The only cookie is the sign-in cookie, set when you sign in to manage a plan or review. It lasts 30 days.</li>
				<li>Sign-in uses an emailed link that expires after 20 minutes and works once. We do not use passwords.</li>
				<li>Your display name appears in the decision log if you review, and on the supporters page only if you ask for credit.</li>
			</ul>
		</section>

		<section>
			<h2>Appeals</h2>
			<p>
				An appeal asks for an email address and your statement. We use the address only to send the appeal link and its
				outcome. The decision and its reasoning are published in the decision log. Your email address never is.
			</p>
		</section>

		<section>
			<h2>Payments</h2>
			<p>
				Checkout runs on a hosted page from our payment provider, which handles card details and tax. We never see or store
				card numbers. We keep the record of your plan and its renewal date.
			</p>
		</section>

		<section>
			<h2>How long we keep it</h2>
			<ul>
				<li>Tags and reports are kept while they count toward a verdict. Verdicts are re-scored every 90 days.</li>
				<li>Server logs never record request paths that contain item or source IDs together with an install hash.</li>
				<li>Unverified appeals expire after 14 days.</li>
				<li>Account data is kept until you ask us to delete it, apart from billing records the law requires us to keep.</li>
			</ul>
		</section>

		<section>
			<h2>Your rights</h2>
			<p>
				You can ask to see, correct, export or delete the data tied to your account or your install ID. Your extension's
				options page can export everything it stores locally. Write to the contact address on our Chrome Web Store listing,
				and we will answer within 30 days.
			</p>
		</section>
	</article>
</div>

<style>
	.doc th[scope='row'] {
		color: var(--cl-text);
		white-space: nowrap;
	}
	@media (max-width: 600px) {
		.doc th[scope='row'] {
			white-space: normal;
		}
	}
</style>
