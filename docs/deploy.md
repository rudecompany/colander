# Deploying and running Colander

This is the owner's runbook for Colander on Cloudflare.
The design and its reasons are in [hosting-plan.md](hosting-plan.md); every wire format is in [contracts.md](contracts.md).
Part 1 is the one-time setup, in the order to do it.
Part 2 is the reference for secrets, variables and the ops channel.
Part 3 is day-2 operations.

## How it fits together

| Environment | Origin | Worker | Deployed by |
| --- | --- | --- | --- |
| production | https://getcolander.com, and the admin host https://admin.getcolander.com behind Cloudflare Access | `colander` | `release.yml`, when you merge a release PR |
| staging | https://staging.getcolander.com, behind Cloudflare Access, and the admin host https://staging-admin.getcolander.com | `colander-staging` | `deploy-staging.yml`, after every green CI run on main |
| Chrome Web Store | the store item, which Chrome, Brave and Opera install from | - | `release.yml`, as a staged publish |
| Edge Add-ons | the store item | - | `release.yml`, submitted for certification once step 18 is done |
| addons.mozilla.org | the listed add-on `colander@getcolander.com` | - | `release.yml`, submitted for review once step 19 is done |

The Worker names come from `api/wrangler.jsonc`; this runbook assumes the top level is production and `env.staging` is staging.
GitHub Actions is the only pipeline, and Workers Builds stays off.

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every pull request and push to main | The required checks: `secrets`, `workflows`, `api`, `contract`, `web-and-extension`, `full-stack` |
| `seed-guard.yml` | every pull request, from the base branch (`pull_request_target`) | The required check `seed-guard`: only an owner changes a cleared seed entry, a clearance or the seed rules and checks (docs/contracts.md 14.2) |
| `deploy-staging.yml` | CI succeeded on main | Builds, deploys staging, runs the mutating smoke test, records a GitHub deployment for the commit |
| `release.yml` | push to main | release-please; on a platform release, production deploy after staging passed the same commit, smoke test, automatic rollback; on an extension release, the Chrome, Edge and Firefox packages and the Firefox sources with provenance, a staged Chrome Web Store submission, and Edge Add-ons and addons.mozilla.org submissions once they are set up |
| `rollback.yml` | by hand | Puts an earlier Worker version back live |
| `ops.yml` | by hand | One command on the ops channel |
| `probes.yml` | hourly at :41, and Mondays 07:23 UTC | Read-only production smoke test and `/ops/status` thresholds hourly, and the Edge Add-ons API key weekly; opens an issue on failure |
| `drills.yml` | Mondays 05:23 UTC, and the 1st at 05:47 UTC | Production dump drill weekly, staging point-in-time restore drill monthly; opens an issue on failure |
| `adapters-daily.yml` | daily 06:17 UTC | Platform adapters against the live sites; opens an issue on failure |

## Part 1: one-time setup

Do these in order.
Commands run from the repository root after `pnpm install`.

### 1. Cloudflare account and Workers Paid

1. Create the Cloudflare account and turn on two-factor authentication.
2. Go to Workers & Pages > Plans and subscribe to Workers Paid ($5 a month).
   Durable Objects with SQLite, Workers Cache and the CPU limit in the plan need it.
3. Copy the account ID from the account home page; it becomes the GitHub variable `CLOUDFLARE_ACCOUNT_ID` in step 15.

### 2. The getcolander.com zone

The domain is already registered with Cloudflare Registrar, so its zone exists and uses Cloudflare nameservers.
1. In Domain Registration > Manage Domains, check that auto-renew is on for getcolander.com.
2. Leave the zone's DNS empty for the apex, `staging`, `admin` and `staging-admin`: the first deploy in step 9 creates all four records as Worker Custom Domains.
   `staging-admin` is a first-level subdomain on purpose, so Universal SSL covers it.

### 3. Bot Fight Mode off

Bot Fight Mode can challenge the extension's API calls and cannot be skipped per path.
Go to getcolander.com > Security > Settings, filter by Bot traffic, and turn Bot Fight Mode off.

### 4. Email Sending

1. Go to Compute > Email Service > Email Sending and select Onboard Domain.
2. Choose getcolander.com and select Done.
   Cloudflare adds the MX, SPF and DKIM records on the `cf-bounce` subdomain and a DMARC record on `_dmarc`.
3. Keep the Resend account and its verified domain: the Worker falls back to Resend on any sending error.

### 5. The ops alert address

The watchdog cron mails alerts through the `ALERTS` binding, which only sends to one verified address.
1. Go to Compute > Email Service > Email Routing > Destination addresses, add the address that should receive alerts, and open the verification link mailed to it.
2. Make sure `destination_address` of the `ALERTS` binding in `api/wrangler.jsonc` is exactly that address, for both environments, and set the `ALERT_ADDRESS` var next to it to the same address (a config test fails when they differ).

### 6. Zero Trust Access for staging

1. Go to Zero Trust and create the free organization if asked.
2. Go to Zero Trust > Access controls > Service credentials > Service Tokens and create a token named `colander-ci-staging` with a duration of 1 year.
   Copy the Client ID and the Client Secret now; the secret is shown once.
   They become the `staging` environment secrets `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in step 15.
3. Go to Zero Trust > Access controls > Applications, add a Self-hosted application named `Colander staging` for the hostname `staging.getcolander.com`, and give it two policies:
   - `CI`: action Service Auth, include Service Token `colander-ci-staging`.
   - `Owners`: action Allow, include the email addresses of the people who test staging in a browser.
4. Add a second Self-hosted application named `Colander staging Stripe webhook` for `staging.getcolander.com` with path `v1/billing/webhook`, with one policy: action Bypass, include Everyone.
   Stripe cannot pass Access, and the webhook checks Stripe's signature itself.
5. Turn on strict service token authentication under Access controls > Access settings, so a bad token gets 401 instead of a login page.

### 6a. The admin hosts: A3T Identity, Access and MFA

Staff and admin authority exists only on `admin.getcolander.com` and `staging-admin.getcolander.com` (contracts 6.9).
Cloudflare Access sits in front of both, with A3T Identity as the identity provider and independent MFA.
Access covers every path at the edge, static files included.
The Worker checks the Access token again on the paths it runs for (`/`, `/admin` and `/admin/*`, `/v1/*`, `/ops/*`, `/__dev/*` and `/healthz`), and binds each staff member to their A3T subject.

1. **A3T Identity client.** In A3T prod (for production) and in A3T dev (for staging), seed a Hydra OAuth client called `colander-access` with a copy of `infra/scripts/seed-admin-oauth-client.sh` from A3T Core:
   - redirect URI `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`, with your Zero Trust team name;
   - scopes `openid email profile`;
   - token endpoint auth method `client_secret_basic`;
   - `skip_consent: true`.
   Keep the client ID and secret for the next step.
2. **Fix email_verified first, or use One-time PIN only.** A3T's consent-server marks every email as verified without checking it, so an A3T account could claim a staff address.
   Until the consent-server sets `email_verified` from Kratos's verifiable-address status, make Access One-time PIN (a verified mailbox) the only login method of the admin applications, with independent MFA keys enrolled beforehand (step 6).
   Do not enable A3T Identity on them meanwhile: an Access email rule matches whatever identity provider the login came from, so an A3T login with a claimed staff address would pass it, and the Worker would bind that login's subject to the staff account.
   The Worker accepts One-time PIN identities for staff accounts.
3. **The identity provider.** In Zero Trust > Integrations > Identity providers, add A3T Identity as a generic OIDC provider with the endpoints from `https://id.a3t.app/.well-known/openid-configuration` (A3T dev's for staging), the client ID and secret from step 1, and PKCE on.
   Under OIDC Claims add `sub`, so Access passes the A3T subject to the Worker in its token's `custom.sub` claim.
   Select Test and check that `sub` appears in `oidc_fields`.
4. **Two Access applications**, one per environment, each with its own AUD tag:
   - `Colander admin` for `admin.getcolander.com`, and `Colander staging admin` for `staging-admin.getcolander.com`.
   - Login methods: One-time PIN only while step 2 applies; after that A3T Identity only, with One-time PIN off.
   - Policy `Staff`: action Allow. With A3T Identity, include the OIDC Claim `sub` equal to each staff member's A3T subject, one value per person, and never email addresses. While step 2 applies, include their email addresses instead.
   - If you ever need both login methods at once (the break-glass in step 7), keep the email addresses in a policy of their own that also requires Login Methods: One-time PIN, so an A3T login never matches them.
   - Session duration 8 hours.
   - Independent MFA: require it, with security keys and platform biometrics allowed. Never turn on skipping MFA based on the identity provider's `amr` claim.
   - Cookie settings: HttpOnly on, SameSite Strict, binding cookie on.
   - Copy each application's AUD tag (Overview > Application Audience (AUD) Tag) and the team domain (`<team>.cloudflareaccess.com`).
5. **The Worker's settings.** In `api/wrangler.jsonc` set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` for production (the `Colander admin` AUD) and for staging (the `Colander staging admin` AUD), and keep `ADMIN_HOST` as `admin.getcolander.com` and `staging-admin.getcolander.com`.
   None of them is secret.
   Until both are set, every admin-host request answers 403, so the admin hosts are safe to deploy before Access exists.
   The admin hosts are already in the `routes` of both environments; the first deploy in step 9 creates their Custom Domains.
6. **Keys, under supervision.** Each staff member registers two keys (security keys, or a security key and a platform biometric) in A3T Identity and in Access independent MFA, in a session you watch, before their `sub` goes into the policy.
   Access lets a person enroll their own MFA after signing in, so a policy entry for someone who has not enrolled yet would trust whoever signs in first.
   You protect the Cloudflare account and the A3T admin account with two hardware keys each.
   **Pin each subject before A3T logins are on.** Once their account is staff or admin (step 16), run the Ops command `pin-subject` for every staff member and for yourself with `{"email": "<their email>", "subject": "<their A3T subject>"}`, the subject you read in A3T Identity, before you add that `sub` to the policy.
   The Worker then refuses any other subject for the account; without a pin it binds the first subject Access lets through.
7. **Recovery.** When a staff member loses a key, take them out of the policy first, have an A3T admin provision a new passkey and reset their Access MFA enrollment, re-enroll under supervision, run `pin-subject` again if their A3T subject changed, then add them back.
   A staff member who joins without an A3T identity needs one first: create an A3T tenant for Colander with `getcolander.com` as its email domain, or add a per-client switch to the consent-server, before you add them.
   If A3T Identity is down, staff work pauses; the product keeps running.
   The break-glass is One-time PIN with the email addresses in its own policy (step 4), for the people whose keys are already enrolled; turn it off again when A3T Identity is back.

### 6b. Turnstile on the sign-in form (optional)

Sign-in codes are already limited per address and per IP, and wrong codes pause code sign-in for an address.
Turnstile adds a challenge in front of `POST /v1/auth/code`; turn it on if the watchdog's `sign_in_mail` alert fires.
1. In the Cloudflare dashboard, go to Turnstile and add a widget for `getcolander.com` and `staging.getcolander.com`, mode Managed.
2. Put the site key in the GitHub repository variable `TURNSTILE_SITE_KEY` (the website build reads it) and the secret key in the Worker secret `TURNSTILE_SECRET_KEY` of both environments (step 8).
   Set both or neither: with only the secret, sign-in stops working.

### 7. Signing keys

One Ed25519 key signs the list, the adapter configuration and plan tokens.
Make keys on a trusted offline machine with Node 24:

```sh
node scripts/keygen.ts production-signing.key       # the key production signs with now
node scripts/keygen.ts production-signing-next.key  # the next key, for rotation
node scripts/keygen.ts staging-signing.key          # staging only, never trusted by a release build
```

Each run prints the public key and the key ID, and never overwrites a file.
Keep two offline copies of both production key files, for example on two encrypted USB drives in different places.
Worker secrets cannot be read back, so these copies are the only way to recover the key.
Write down the public keys:
- `COLANDER_PUBLIC_KEYS` (GitHub repository variable) is the production public key, a comma, and the next public key.
- `STAGING_PUBLIC_KEYS` (GitHub `staging` environment variable) is the staging public key.

Commit the same production pair as `WXT_COLANDER_PUBLIC_KEYS=<current>,<next>` in `extension/release.env`, through a pull request.
Store packages are built from that file, so AMO's reviewers rebuild the Firefox package byte for byte, and the release job refuses to build while it differs from `COLANDER_PUBLIC_KEYS`.
Public keys are not secret.

### 8. R2 buckets and Worker secrets

Before you start, have the `colander-analytics` token from step 10 ready (it is a Worker secret).
1. Log Wrangler in as the owner: `pnpm -C api exec wrangler login`.
2. Run `scripts/cloudflare-bootstrap.sh`.
   It reads the R2 bindings of both environments from `api/wrangler.jsonc`, creates the list and backup buckets with the `enam` location hint, sets lifecycle rules (dumps, restore bookmarks, seed lists and calibration exports expire after 90 days, erasure records and seed list suppression records after 120, the audit log's daily copies after 400, unfinished multipart uploads after a day), and puts a 7-day bucket lock on the Store dumps (`dumps/`), restore bookmarks (`pitr/`), erasure records (`erasures/`) and suppression records (`objections/`) of the backup buckets and a 400-day lock on their `audit/` prefix.
   Seed list files and calibration exports stay unlocked, so `revoke-seed` and an objection can delete them at once.
   It is safe to run again.
3. Run every secret command the script prints, for production and for staging.
   They read values from stdin, so nothing lands in shell history.
   The ops channel has no secret: the workflows prove themselves with GitHub OIDC tokens (Part 2, The ops channel).
4. Check with `pnpm -C api exec wrangler secret list` and `pnpm -C api exec wrangler secret list --env staging`.

### 9. The first deploy of each environment

The first deploy attaches the Custom Domains (the site and the admin host of each environment) and creates the Store's Durable Object namespace, which needs more rights than CI tokens get.
Do it once from your machine, still logged in as the owner:

```sh
pnpm -C web build
pnpm -C api exec wrangler deploy --env staging
pnpm -C api exec wrangler deploy    # the release workflow later rebuilds the site with the store links
```

These first builds warn that `COLANDER_BUILD_API` is not set: there is no production Worker yet to read live numbers from, so the pages fill them in once the browser fetches them.
The release workflow builds every later production website with `COLANDER_BUILD_API=https://getcolander.com`, so its pages prerender with the live numbers and latest decisions.

Then check both with the smoke test (the mutating run on staging decides through the ops channel, Part 2):

```sh
COLANDER_BASE_URL=https://getcolander.com COLANDER_PUBLIC_KEYS=<production public key> node scripts/smoke.ts
```

From now on only the workflows deploy.

### 10. Cloudflare API tokens

Create account API tokens under Manage account > Account API tokens, each with an expiry one year out and a calendar reminder to rotate it.

| Token | Permissions | Stored as |
| --- | --- | --- |
| `colander-ci-production` | Account > Workers > Editor, scoped to the Worker `colander`; Account > Account Settings > Read | `CLOUDFLARE_API_TOKEN` in the GitHub `production` environment |
| `colander-ci-staging` | Account > Workers > Editor, scoped to the Worker `colander-staging`; Account > Account Settings > Read | `CLOUDFLARE_API_TOKEN` in the GitHub `staging` environment |
| `colander-analytics` | Zone > Analytics > Read, zone getcolander.com | Worker secret `CF_ANALYTICS_TOKEN` in both environments |

The hourly analytics pull also needs the zone ID: copy it from the getcolander.com overview page into the `CF_ZONE_ID` var of both environments in `api/wrangler.jsonc`.
It is not secret, and both environments use the same zone; each one counts only requests to its own host.
Until the token and the zone ID are both set, the pull is skipped with a log line.

Per-Worker Editor can deploy, list versions and roll back, but cannot create a Worker or change a Custom Domain, which is why step 9 runs by hand.
If a later change to `api/wrangler.jsonc` adds or changes routes or Custom Domains, deploy that change once by hand the same way, or the CI deploy fails on authorization.

### 11. Stripe

1. In live mode, create the Plus product with two recurring prices, $3 a month and $30 a year.
2. Apply for Managed Payments; until Stripe approves it, set `STRIPE_MANAGED_PAYMENTS` to `0` for production.
3. Add a webhook endpoint at `https://getcolander.com/v1/billing/webhook` on API version `2026-04-22.dahlia` with the events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed` and `charge.refunded`.
4. Put the live secret key and the webhook signing secret in the production Worker secrets (step 8).
5. Put the two price IDs in the production `vars` of `api/wrangler.jsonc` (`STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PLUS_YEARLY`); they are not secret.
6. Repeat 1, 3, 4 and 5 in test mode for staging, with the endpoint `https://staging.getcolander.com/v1/billing/webhook`.
7. Set a support email in the public business details.

### 12. YouTube Data API key

1. In a Google Cloud project, enable the YouTube Data API v3.
   Use one project for Colander: splitting one use case's quota across projects breaks the YouTube API Services Developer Policies.
2. Create an API key restricted to that API.
3. Put it in the `YOUTUBE_API_KEY` Worker secret of both environments (step 8).
4. Leave `YOUTUBE_DAILY_UNITS` in `api/wrangler.jsonc` at `7000` for production and `1000` for staging; neither Worker spends more than its own per Pacific day.
   Both spend the one project's 10,000 units but each keeps its own ledger, so together they stay at 8,000, and a config test fails any change that passes that.
   Change both together if the project's quota changes.
5. Leave `YOUTUBE_DERIVED_USE` empty.
   Set it to `1` only after YouTube approves Colander's derived metrics in the Audit and Quota Extension Form; until then no subscriber count or uploads per day reaches a verdict (contracts 9.7).

### 13. Chrome Web Store developer account and item

The API cannot create items, so the first package goes up by hand.
1. Register as a Chrome Web Store developer with the publishing Google account, and turn on 2-step verification for it.
2. Build a store package for the first upload, from `extension/release.env` with the keys from step 7; store builds carry no manifest key, which the store rejects:

   ```sh
   bash extension/scripts/build-store.sh chrome
   ```

3. In the Developer Dashboard select Add new item and upload `extension/dist/colanderextension-1.0.0-chrome.zip`.
4. The listing title comes from the manifest name, "Colander: drain the slop from your feed", so the dashboard does not ask for one.
   Fill in the Store listing's description and the store art from `extension/store/`, and the Privacy tab.
   Add one line to the description for Brave and Opera, which install from this listing: "Also for Brave, and for Opera with Opera's Install Chrome Extensions add-on."
5. Copy the item ID (it is the extension ID) and the publisher ID from Account > Publisher settings.
   They become the variables `CWS_ITEM_ID` (repository) and `CWS_PUBLISHER_ID` (environment `chrome-web-store`).
   `CWS_ITEM_ID` also points the website's Chrome install buttons at the listing; until it is set they open a store search.
6. Submit this first version from the dashboard with "publish after review" turned off, so it waits until production is live.

### 14. Keyless publishing from GitHub (Workload Identity Federation)

The release workflow gets a short-lived Google token through GitHub's OIDC token, so no key file exists anywhere.
Run this once with gcloud, logged in as a project owner:

```sh
PROJECT_ID=colander-publishing    # an existing or new Google Cloud project
gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud services enable chromewebstore.googleapis.com iamcredentials.googleapis.com sts.googleapis.com iam.googleapis.com

gcloud iam service-accounts create cws-publisher --display-name="Colander Chrome Web Store publisher"

gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc colander --location=global --workload-identity-pool=github \
  --display-name="rudecompany/colander" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository == 'rudecompany/colander'"

# Only jobs in the chrome-web-store environment of this repository may act as the publisher.
gcloud iam service-accounts add-iam-policy-binding "cws-publisher@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role=roles/iam.workloadIdentityUser \
  --member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/subject/repo:rudecompany/colander:environment:chrome-web-store"

gcloud iam workload-identity-pools providers describe colander --location=global --workload-identity-pool=github --format='value(name)'
```

1. The last command prints `projects/<number>/locations/global/workloadIdentityPools/github/providers/colander`; it becomes `GCP_WORKLOAD_IDENTITY_PROVIDER`.
2. `cws-publisher@<project>.iam.gserviceaccount.com` becomes `GCP_SERVICE_ACCOUNT`.
3. In the Chrome Web Store Developer Dashboard, under Account, add that service account email; a publisher can have one.
4. Allow up to 5 minutes for the pool and the binding to take effect.

### 15. GitHub repository settings

Create the public repository `rudecompany/colander` and push main.
Then, with `gh` logged in as an admin:

**Merging.**
Allow squash merging only, with the pull request title as the commit message.
Titles must follow Conventional Commits (`feat: ...`, `fix: ...`, `feat!: ...`), because release-please reads them to decide the next version.

```sh
gh api -X PATCH repos/rudecompany/colander -F allow_squash_merge=true -F allow_merge_commit=false \
  -F allow_rebase_merge=false -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY -F delete_branch_on_merge=true
```

**Required checks on main.**
These are the exact check names, one per CI job: `secrets`, `workflows`, `api`, `contract`, `web-and-extension`, `full-stack`, and `seed-guard` from `seed-guard.yml`.

```sh
gh api -X POST repos/rudecompany/colander/rulesets --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true, "require_last_push_approval": false,
        "required_review_thread_resolution": true, "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "secrets", "integration_id": 15368 },
          { "context": "workflows", "integration_id": 15368 },
          { "context": "api", "integration_id": 15368 },
          { "context": "contract", "integration_id": 15368 },
          { "context": "web-and-extension", "integration_id": 15368 },
          { "context": "full-stack", "integration_id": 15368 },
          { "context": "seed-guard", "integration_id": 15368 } ] } }
  ]
}
JSON
```

`15368` is the GitHub Actions app, so only Actions can satisfy these checks.
Code owner review guards the seed registry (`.github/CODEOWNERS`, docs/contracts.md section 14): a pull request that touches it needs your approval.
You cannot approve your own pull request, so repository admins (role `5`) may merge one past that rule; the `seed-guard` check still fails any change to a clearance, a cleared entry or the seed rules and checks that you did not make.
It runs the base branch's own checker, so a pull request that edits the checker, its rules or `ci.yml` cannot pass it.

**Immutable releases.**
`gh api -X PUT repos/rudecompany/colander/immutable-releases`.
release-please makes draft releases; the workflows attach assets and then publish them, after which nothing about a release can change.

**The release-please GitHub App.**
Releases are proposed by a GitHub App, because pull requests opened with the workflow token do not run CI, and the required checks would never pass.
1. Create a GitHub App owned by `rudecompany` named `colander-release`, with webhooks off, and repository permissions Contents: Read and write, Pull requests: Read and write, Issues: Read and write.
2. Install it on `rudecompany/colander` only.
3. Store its Client ID as the repository variable `RELEASE_APP_CLIENT_ID`, generate a private key, and store the whole PEM as the repository secret `RELEASE_APP_PRIVATE_KEY`.

**Actions.**
Allow only the actions the workflows use, pinned by full commit SHA (the workflows pin every action that way, and Dependabot keeps the pins current):

```sh
gh api -X PUT repos/rudecompany/colander/actions/permissions -F enabled=true -f allowed_actions=selected -F sha_pinning_required=true
gh api -X PUT repos/rudecompany/colander/actions/permissions/selected-actions --input - <<'JSON'
{ "github_owned_allowed": true, "verified_allowed": false,
  "patterns_allowed": ["pnpm/action-setup@*", "cloudflare/wrangler-action@*", "googleapis/release-please-action@*", "google-github-actions/auth@*"] }
JSON
```

Dependabot skips `seed-guard.yml`, which only the seed registry's owner may change: after Dependabot moves the other pins, bump its two pins to the same SHAs in a pull request of your own.

**Environments.**
Create the three environments, each limited to deployments from main.
The ops channel takes only GitHub OIDC tokens that name the environment of the Worker it calls, from a workflow on main, so these branch policies and the main ruleset above are what guard staging and production data:

```sh
for env in staging production chrome-web-store; do
  gh api -X PUT "repos/rudecompany/colander/environments/$env" --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
  gh api -X POST "repos/rudecompany/colander/environments/$env/deployment-branch-policies" -f name=main -f type=branch
done
```

Do not add required reviewers to `staging` or `production`: the hourly probes and the drills use them unattended and would wait for approval forever.
Merging the release PR is the approval for production.
Required reviewers on `chrome-web-store` are fine if you want a second look before a store submission.

**Secrets and variables.**
Set each one with `gh secret set NAME [--env ENV]` or `gh variable set NAME [--env ENV]`, which read the value from stdin; the full table is in Part 2.

### 16. The first admin, and reviewers

1. After the first production deploy, run the Ops workflow with environment `production`, command `grant-role` and args `{"email": "<your email>", "role": "admin"}`.
   The ops channel grants admin only once, and never again even if no admin is left; every later role change happens on the admin host.
   Do the same on staging.
2. Open https://admin.getcolander.com, sign in through Access, and check that People shows you as Admin and bound to A3T Identity.
3. Make staff and curators on People, then use Invite on each: send the link through a channel you trust.
   The invite works once, within 24 hours, and only after the person signs in with their email; it adds the passkey that reviewing on getcolander.com and the side panel need.
   An admin cannot invite themselves; admins and staff review on the admin host, where Access is the sign-in.
   Reviewers connect the side panel with a reviewer code from their account page; its token lasts 7 days and carries curator authority only.

The staging smoke test and the restore drill need no reviewer account: they decide on two fictional check channels through the ops command `check-decision`.

### 17. Check the whole path

1. Merge a small `fix:` pull request.
   CI passes, `deploy-staging` deploys it and its smoke test passes.
2. release-please opens a release PR; merge it.
   `release.yml` waits for staging, deploys production, smoke-tests it and publishes the release `v1.0.1`.
3. Run the Probes workflow by hand and check that it passes.

### 18. Microsoft Edge Add-ons

Edge ships first after Chrome, with the same code; the Edge package is the Chrome one without a manifest key.
The API cannot create a product, so the first version goes up by hand.
1. Register as a Microsoft Edge developer in Partner Center (https://partner.microsoft.com/dashboard/microsoftedge/), which is free, with the account that will own the listing, and turn on two-step verification for it.
2. Select Create new extension and upload `colanderextension-<version>-edge.zip` from the latest `extension-v*` GitHub release (it carries provenance), or build it with `bash extension/scripts/build-store.sh edge`.
3. Availability: public, all markets.
4. Properties: category Productivity, the privacy policy URL https://getcolander.com/privacy, and the website https://getcolander.com.
   Edge asks why each permission is needed: use the Why column of the permissions table on https://getcolander.com/privacy.
5. Store listing (en-US): the description from the Chrome Web Store listing, the logo (300 by 300 recommended, at least 128 by 128; `extension/store/icon-128.png` meets the minimum), and from `extension/store/` the 440 by 280 small tile, the 1400 by 560 large tile and the 1280 by 800 screenshots.
6. Make a test account for store reviewers: a Colander account whose Plus costs nothing, through a 100% off coupon on its subscription in the Stripe dashboard, so they can try the plan pairing code.
   If they should see the review side panel, make it a curator (Ops command `grant-role`, or People on the admin host) and send it a passkey invite from People, since a reviewer code needs a passkey sign-in.
   The 14-day trial in Options shows Plus without any account.
7. Submission options, Notes for certification: that blocking needs no account, that Plus and the review side panel connect with a pairing code from the website, and the test account's sign-in.
   Then select Publish; certification takes up to 7 business days.
8. Turn on the Publish API: in Partner Center open Microsoft Edge, then Publish API, and create API credentials.
   Copy the Client ID and the API key now; the key is shown once.
9. Copy the Product ID, the GUID on the extension's overview page in Partner Center (not the ID in the store address).
10. Create the environment `edge-add-ons` limited to main, as in step 15, without required reviewers, since the weekly key check uses it unattended:

    ```sh
    gh api -X PUT repos/rudecompany/colander/environments/edge-add-ons --input - <<'JSON'
    { "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
    JSON
    gh api -X POST repos/rudecompany/colander/environments/edge-add-ons/deployment-branch-policies -f name=main -f type=branch
    gh secret set EDGE_CLIENT_ID --env edge-add-ons
    gh secret set EDGE_API_KEY --env edge-add-ons
    gh variable set EDGE_PRODUCT_ID
    ```

    With `EDGE_PRODUCT_ID` set, every extension release uploads the Edge package and submits it for certification (`submit-edge-add-ons`), and the weekly probe checks the key.
11. Once the listing is live, copy its item ID from the store address (`https://microsoftedge.microsoft.com/addons/detail/<item ID>`) into the repository variable `EDGE_ITEM_ID`.
    The next production deploy shows Add to Edge to Edge visitors; until then they are sent to the Chrome Web Store, which Edge can install from.

The API key expires 72 days after it is made, and Microsoft's reminder emails are not reliable: see Rotate credentials.

### 19. Mozilla addons.mozilla.org

Firefox ships second, as a listed add-on with the permanent ID `colander@getcolander.com`.
AMO's reviewers rebuild the package from the sources zip each release attaches, following `extension/AMO_REVIEW.md`.
1. Create a Firefox account for the add-on at https://addons.mozilla.org/developers/, turn on two-factor authentication, and accept the developer agreement.
2. Write the sign-in steps of the test account from step 18 as plain text; they become the secret `AMO_REVIEWER_NOTES`, sent as each version's notes for reviewers.
3. Submit the first version by hand: in the Developer Hub select Submit a New Add-on, choose On this site, and upload `colanderextension-<version>-firefox.zip` from the latest `extension-v*` release.
   When asked whether the add-on needs source code, answer yes and upload `colanderextension-<version>-sources.zip` from the same release.
4. Listing: the name and summary from `extension/amo/metadata.json`, category Privacy and Security, the license All Rights Reserved (change it in the metadata file and here if the code gets an open license), the privacy policy text from https://getcolander.com/privacy, and the support site https://getcolander.com.
   Choose a slug for the listing address, such as `colander`.
   Paste `AMO_REVIEWER_NOTES` into Notes to Reviewer.
5. Get an API key at https://addons.mozilla.org/developers/addon/api/key/: the JWT issuer and the JWT secret.
6. Create the environment `amo` limited to main, as in step 15, and store the secrets:

   ```sh
   gh api -X PUT repos/rudecompany/colander/environments/amo --input - <<'JSON'
   { "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
   JSON
   gh api -X POST repos/rudecompany/colander/environments/amo/deployment-branch-policies -f name=main -f type=branch
   gh secret set AMO_JWT_ISSUER --env amo
   gh secret set AMO_JWT_SECRET --env amo
   gh secret set AMO_REVIEWER_NOTES --env amo
   ```

7. Once AMO approves the first version and the listing is public, set the repository variable `AMO_SLUG` to its slug.
   From then on every extension release submits the Firefox package with its sources for review (`submit-amo`, with `web-ext sign`), and the next production deploy shows Add to Firefox to Firefox visitors and names Firefox on the website.
   Signing usually takes under a day; a manual review can take longer.

AMO may ask whether tags and reports need a required data collection kind, since they carry the install ID; the first submission's notes should invite that question, and the answer goes in `extension/wxt.config.ts`.

### Opera, if its traffic grows

Opera users install from the Chrome Web Store with Opera's Install Chrome Extensions add-on, which the website tells them.
A listing on addons.opera.com is optional and manual: there is no publishing API.
It needs an addons.opera.com account, the Chrome package uploaded by hand (`bash extension/scripts/build-store.sh chrome`), and an attached license or terms, or Opera applies CC BY-NC-ND to the listing.

### 20. Seed data and the YouTube Data API

Outside lists are review leads only: they put sources in the review queue and never decide a verdict (docs/contracts.md section 14).
Nothing is imported until you clear it, and every step below is yours, because each one needs your judgment, your counsel or your accounts.
Until then the registry's entries stay pending, `import-seed` refuses them, and `/credits` says that no dataset needs credit yet.

**Decisions**

- D1. Public pages and the decision log never name a data source; `/credits` names only the datasets whose license asks for credit.
  This is built and tested; nothing to do unless you change the rule.
- D2. Your GitHub login, `slantview`, is the one entry of `SEED_OWNERS` in `packages/shared/src/seeds.ts` and of `.github/CODEOWNERS`.
  Turn on code owner review with the ruleset in step 15, so a pull request that touches the registry needs your approval.
  To add an owner, change both files in a pull request of your own.
  Do not add required reviewers to the `production` environment for this: the probes and drills run there unattended.
- D3. After counsel, clear the day-one entries one at a time (Part 3, "Import a seed list"):
  - `aislist-cc0-20260115-blocklist` and `aislist-cc0-20260115-warnlist`: AiSList at commit `50f476b8`, its last CC0 version. Lead only; never promote it to `seed`.
  - `cevval-yt-ai-music`: pin the commit you import in `upstream.ref`; it expires 90 days after that commit's date, so import its newer versions the same way.
  - `soul-over-ai-cc-by`: find the last commit whose `LICENSE.md` is CC BY 4.0 and pin it. Only fully AI-generated artists are read, and only their YouTube channel IDs.
  - `staff-research`: the channels staff found themselves, one per line with a note of where they saw it. A large channel needs two reviewers.
  - `tubecensus-sample`: a random sample of TubeCensus channel IDs, used only to sample calibration negatives. Its `scraped` stays null until counsel says whether IDs from Internet Archive captures of YouTube pages are scraped YouTube data; it cannot be cleared before.
  Before the first one, have counsel sign off the credits approach, the DPIA and the legitimate interest assessment, and appoint the EU and UK representatives under GDPR Article 27.
  Naming them on the privacy page is a precondition of the first import: set `REPRESENTATIVES` in `web/src/routes/privacy/+page.svelte` and let it deploy.
  The rest of the Creators section, with its legal basis, and `/credits` are live already.
- D4. The numbers, in code where you can change them in a pull request: the promotion thresholds (`CALIBRATION` in `packages/shared/src/seeds.ts`: 100 labeled sources, 30 per group, lower bounds of 0.90 AI-made and 0.80 slop), each entry's `expires_after_days`, `YOUTUBE_DAILY_UNITS` (step 12), and who labels (curators and staff).
- D5. Staff time: about 100 hours of labeling for 1,000 sources, by 2 or 3 trained labelers working from `/definition`.
  A starting mix: 150 each from `seed:` the AiSList blocklist, Cevval and Soul Over AI, 150 from `community`, and 300 from `random:tubecensus-sample`.
- D6. Courtesy notes to the CC0 maintainers (Override92 for AiSList, cevvalkoala for Cevval), which also ask how each list was collected.
  Not legally required.

**Keys and the YouTube audit**

- K1. One Google Cloud project for Colander, registered for the "Internal Company Tool" use case, with one `YOUTUBE_API_KEY` per environment restricted to the YouTube Data API v3 (step 12).
  Never a second project for the same use: that splits one use case's quota.
- K2. Before the Audit and Quota Extension Form: the privacy page names YouTube API Services and links Google's Privacy Policy (done), the terms bind users to YouTube's Terms of Service (add this with counsel), any page that shows API data carries YouTube's branding (no public page shows any), and a demo account for YouTube's reviewers.
- K3. Submit the Audit and Quota Extension Form yourself, after counsel has said whether the extension's changes to YouTube's pages make it part of Colander's API client.
  Include the derived-metrics amendment only if you want subscriber counts and uploads per day to feed scoring; until YouTube approves it, leave `YOUTUBE_DERIVED_USE` empty.

## Part 2: reference

### Secrets and variables

Until `CLOUDFLARE_ACCOUNT_ID` is set, staging deploys, probes and drills skip instead of failing.
Until `RELEASE_APP_CLIENT_ID` is set, release-please and every release job skip.
Until `EDGE_PRODUCT_ID` and `AMO_SLUG` are set, the Edge and AMO submissions and the Edge key probe skip, and until `EDGE_ITEM_ID` and `AMO_SLUG` are set the website does not offer those stores.

| Name | Kind | Where | Value |
| --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | variable | repository | Cloudflare account ID |
| `COLANDER_PUBLIC_KEYS` | variable | repository | Production public key, comma, next public key (step 7) |
| `CWS_ITEM_ID` | variable | repository | Chrome Web Store item ID, which is also the extension ID; the website's Chrome install link |
| `EDGE_PRODUCT_ID` | variable | repository | Partner Center product ID of the Edge extension (step 18); turns on `submit-edge-add-ons` and the weekly key probe |
| `EDGE_ITEM_ID` | variable | repository | Edge Add-ons item ID from the store address (step 18); the website's Edge install link |
| `AMO_SLUG` | variable | repository | addons.mozilla.org slug of the public listing (step 19); turns on `submit-amo` and the website's Firefox install link |
| `RELEASE_APP_CLIENT_ID` | variable | repository | Client ID of the `colander-release` GitHub App |
| `RELEASE_APP_PRIVATE_KEY` | secret | repository | Private key PEM of that App |
| `CLOUDFLARE_API_TOKEN` | secret | `staging` | `colander-ci-staging` token |
| `CF_ACCESS_CLIENT_ID` | secret | `staging` | Access service token Client ID |
| `CF_ACCESS_CLIENT_SECRET` | secret | `staging` | Access service token Client Secret |
| `STAGING_PUBLIC_KEYS` | variable | `staging` | Staging public key |
| `CLOUDFLARE_API_TOKEN` | secret | `production` | `colander-ci-production` token |
| `TURNSTILE_SITE_KEY` | variable | repository | Optional: the Turnstile site key the website build embeds (step 6b) |
| `CWS_PUBLISHER_ID` | variable | `chrome-web-store` | Chrome Web Store publisher ID |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | variable | `chrome-web-store` | Full provider name from step 14 |
| `GCP_SERVICE_ACCOUNT` | variable | `chrome-web-store` | `cws-publisher@<project>.iam.gserviceaccount.com` |
| `EDGE_CLIENT_ID` | secret | `edge-add-ons` | Publish API client ID (step 18) |
| `EDGE_API_KEY` | secret | `edge-add-ons` | Publish API key, which expires after 72 days (step 18) |
| `AMO_JWT_ISSUER` | secret | `amo` | addons.mozilla.org API key, the JWT issuer (step 19) |
| `AMO_JWT_SECRET` | secret | `amo` | addons.mozilla.org API secret (step 19) |
| `AMO_REVIEWER_NOTES` | secret | `amo` | Notes for AMO's reviewers with the test account's sign-in (step 19) |

Worker secrets, per environment, set with `wrangler secret put` and never stored in GitHub: `COLANDER_SIGNING_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `YOUTUBE_API_KEY`, `RESEND_API_KEY`, `CF_ANALYTICS_TOKEN`, `IP_SALT`, and optionally `TURNSTILE_SECRET_KEY`.
Worker vars in `api/wrangler.jsonc`, not secret: `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `ADMIN_HOST` per environment (step 6a), and `OPS_GITHUB_REPOSITORY`, `OPS_GITHUB_REPOSITORY_ID` and `OPS_GITHUB_ENVIRONMENT`.
`.github/actionlint.yaml` lists every variable the workflows read, so CI fails on a misspelled one.

### The ops channel

The workflows talk to the Worker through one authenticated channel, and the Worker must implement exactly this:
- Request: `POST /ops/<command>` with `Authorization: Bearer <GitHub Actions OIDC token>`, `Content-Type: application/json` and a JSON object body.
  The job has `permissions: id-token: write` and asks GitHub for a token with the Worker's origin as its audience (`https://getcolander.com` or `https://staging.getcolander.com`); each token lives 5 minutes.
- The Worker verifies the token against GitHub's published keys (`https://token.actions.githubusercontent.com/.well-known/jwks`) and requires: issuer `https://token.actions.githubusercontent.com`, audience its `PUBLIC_URL`, `repository` equal to `OPS_GITHUB_REPOSITORY` and `repository_id` to `OPS_GITHUB_REPOSITORY_ID`, `ref` `refs/heads/main`, a `workflow_ref` of this repository on `refs/heads/main`, and `environment` equal to `OPS_GITHUB_ENVIRONMENT`.
  Anything else answers 401 without detail.
  There is no static token, so a leaked secret cannot reach it; a workflow on another branch or in a fork gets no matching token.
- Each workflow runs only the commands its jobs need (`403 not_this_workflow` otherwise): `ops.yml` every command, `probes.yml` `status`, `drills.yml` `drill` on production and `status`, `check-decision` and `pitr-restore` on staging, and `deploy-staging.yml` `check-decision`.
  So the seed list commands (`import-seed`, `revoke-seed`, `calibration-sample`, `calibration-export`), like `grant-role`, `pin-subject`, `sign-config` and the restores, run from the Ops workflow alone.
  The job that asks for the token runs no third-party code: `deploy-staging.yml` installs and builds in a job without `id-token: write`, and smoke-tests in a separate job that runs only Node.
- Every command except `status` writes the audit log with the GitHub login and run ID from the verified token, not from anything the client sends.
- Response: JSON.
  Any 2xx status means the command succeeded; anything else means it failed, with a contract error body.
- On staging the requests also carry the Access service token headers.
- A local dev stack (`COLANDER_DEV=1` on `http://localhost`) also takes `OPS_TOKEN` from `api/.dev.vars`; no deployed environment has it.

| Command | Body | Success answer |
| --- | --- | --- |
| `status` | `{}` | `head_seq` (Store list head), `r2_seq` (sequence in R2's `list/snapshot.bin`), `pass_age_s` (seconds since the last completed scoring pass), `publish_lag_s` (seconds the oldest verdict change not yet in R2's list has waited, 0 when R2 holds the head), `dump_age_s` (seconds since the newest successful dump), `dump_ms`, `rows_read_last_pass` |
| `grant-role` | `{"email", "role"}` with role `member`, `curator`, `staff` or `admin`. Until it first grants admin it grants any role, so the owner bootstraps the first admin; after that it moves only member and curator accounts between member and curator (`403 admin_exists`), even if no admin is left. Raising a role ends the account's sessions and deletes its passkeys, reviewer token and unused pairing codes. | The account |
| `pin-subject` | `{"email", "subject"}`: binds a staff or admin account to its A3T subject before that person's first A3T sign-in, replacing an earlier pin (step 6a). `409 subject_taken` when another account holds it. | The account |
| `import-seed` | `{"seed", "apply"}`: `seed` a registry ID the owner cleared, `apply` true to write; without it the command is a dry run. The list is the object `seeds/<seed>.json` in the environment's backup bucket (Part 3, "Import a seed list"). | The change in counts (`entries`, `by_platform`, `added`, `kept`, `dropped`, `suppressed`, `skipped`, `excluded`) and, applied, the batch ID; never a channel. Entries become review leads, never verdicts. |
| `revoke-seed` | `{"seed", "reason"}`, and confirm set to the seed ID. The reason is public in the run log: never name a creator or give legal advice in it. | The entries and calibration items deleted, the sources they were on, and whether the list file `seeds/<seed>.json` was deleted (`file`) |
| `calibration-sample` | `{"frame", "n"}`: frame `community`, `seed:<id>` or `random:<id>`, n 1 to 1,000 | How many sources were added to the calibration set, and how many were available |
| `calibration-export` | `{}` | The key of the export under `calibration/` in the backup bucket, and its item and label counts |
| `sign-config` | `{}`: the Worker reads `extension/src/adapters/default-config.json` itself from `raw.githubusercontent.com` at the commit on main the run started from (the token's `sha`) and signs it byte for byte. A body with `file` is `400`. | Version, key ID and the commit |
| `drill` | `{}` | `{"ok": true, ...}` after the dump drill passed (hosting plan section 3) |
| `purge-cache` | `{"confirm": "purge-cache"}` | Done |
| `restore-dump` | `{"key", "confirm"}`, confirm equal to key | Done |
| `pitr-restore` | `{"at", "confirm"}`, `at` an RFC 3339 time and confirm equal to it | The bookmark and the undo bookmark, also kept in the backup bucket under `pitr/` |
| `check-decision` | `{"source", "reason"}`, source `@colander-smoke` or `@colander-drill`: toggles that fictional channel between Clear and not rated, as a curator decision. Staging and dev only (`403` in production). | The source and the verdict it set |

After either restore, the Worker deletes again every account erased since (the erasure records under `erasures/` in the backup bucket) before it publishes.
It also ends every session, reviewer token, unused pairing code and sign-in flow, and repeats what the audit log records was taken away after the restore point (a dump's restore point is the time in its name): revoked accounts and moved addresses lose their passkeys again, removed passkeys go again, lowered roles are lowered again, A3T subjects are pinned again, and cancelled or refused held requests stay cancelled.
Nothing is given back, so a role raised after the restore point is not raised again.
Then it repeats every seed list suppression and lift staff made, oldest first, from their records under `objections/` in the backup bucket, so an objection under GDPR Article 21 holds even for a channel the restored data lacks.
Both answers add `revocations_reapplied`, the number of audit rows it repeated, and `suppressions_reapplied`, the number of suppression records.

The probes require `pass_age_s` under 900, `dump_age_s` under 25,200 and `publish_lag_s` under 21,600.
The restore drill (`scripts/pitr-drill.ts`) uses `head_seq` and `r2_seq`.

## Part 3: day-2 operations

### Deploy

1. Merge a pull request to main; its title is its commit message, in Conventional Commits form.
2. CI runs on main, and `deploy-staging` deploys the commit to staging and smoke-tests it.
3. release-please keeps a release PR open with the next versions and changelogs; never edit a CHANGELOG.md by hand.
4. Merging the release PR deploys production: `release.yml` waits until staging passed that commit, records the live version, runs `wrangler deploy --tag vX.Y.Z`, smoke-tests production read-only, and publishes the release.
   If the smoke test fails it rolls back to the recorded version and the job fails.
5. An extension release (a change under `extension/`) builds the Chrome, Edge and Firefox packages from `extension/release.env`, checks them, rebuilds the Firefox package from its sources zip byte for byte, attests all four files and attaches them to the `extension-vX.Y.Z` release.
   It submits the Chrome package as a staged publish; after review, publish it from the Developer Dashboard once the backend it needs is live in production.
   Once steps 18 and 19 are done it also submits the Edge package for certification and the Firefox package with its sources for AMO review, and those stores publish each version when it passes.

A change to `packages/shared` releases with the platform.
When it also changes the extension, touch `extension/` in the same pull request or add a `Release-As:` footer.

### Roll back

Run the Rollback workflow with the environment, the release tag (for example `v1.4.2`) or a Worker version ID, and a reason.
It finds the version, runs `wrangler rollback`, and smoke-tests the result.
Only the 10 most recent versions can be found by tag; for older ones use the ID from `pnpm -C api exec wrangler versions list`.
A rollback restores code, static assets and crons, never data; Wrangler refuses one across a Durable Object class migration.
Migrations are forward-only and the runner ignores migrations newer than it knows, so older code still starts on a newer schema.

### Ops commands

Run the Ops workflow, choose the environment and command, and give the arguments as JSON.
The run log and its summary are the audit trail.
Examples:
- Make a curator: command `grant-role`, args `{"email": "sam@example.com", "role": "curator"}`.
- Ship new adapter selectors: raise `version` in `extension/src/adapters/default-config.json`, merge it, then run command `sign-config` with args `{}`.
  The Worker signs the file exactly as it is on main at that run's commit, never text from the run.
- Import a seed list (docs/contracts.md section 14).
  Only datasets in the seed registry, `packages/shared/src/seed-registry.json`, can be imported, and only once you have cleared them there (step 20, D3).
  The repository, the run log and its summary are public, so never commit a list; the list and its clearance records travel in a private object of the backup bucket, and the answer carries counts only.
  1. Check the list's license file at the exact version you import, and its `collection` statement.
  2. Clear the entry in a pull request of your own: set `sha256` to the SHA-256 of the exact file (`shasum -a 256 list.txt`), `upstream.ref` and `upstream.date` to its commit or version and that date, `scraped` to false once the maintainer has said so, and `clearance` to `{"status": "cleared", "by": "slantview", "at": "<today>"}`.
     Merge it and let it deploy: the same deploy puts the dataset on `/credits` when its license asks for credit.
  3. Build the object and put it under `seeds/<id>.json` in the environment's backup bucket (`colander-backups`, or `colander-staging-backups` for staging).
     `records` says where the data protection impact assessment and the legitimate interest assessment are kept, and for a written grant where the grant is kept (`permission_doc`); keep the documents themselves private.
     ```sh
     jq -n --rawfile file list.txt '{file: $file, records: {dpia: "DPIA-2026-01", lia: "LIA-2026-01"}}' >seed.json
     pnpm -C api exec wrangler r2 object put colander-backups/seeds/aislist-cc0-20260115-blocklist.json --file seed.json --remote
     ```
     The bucket's lifecycle deletes the object after 90 days; `seed_imports` keeps its hash and records.
  4. Run command `import-seed` with args `{"seed": "aislist-cc0-20260115-blocklist"}`: a dry run that answers what would change.
  5. Run it again with args `{"seed": "aislist-cc0-20260115-blocklist", "apply": true}`.
     The scoring pass then puts the sources in the review queue as seed leads; they never give a verdict and are never named in public.
  A newer version of the list is the same steps with the new hash and date: entries it no longer lists are deleted, and so are sources only they made.
- Withdraw a seed list at once, when its license or clearance falls away: command `revoke-seed`, args `{"seed": "<id>", "reason": "<why>"}`, confirm set to the same ID.
  The run log is public, so keep the reason short and general, such as "License withdrawn": never name a creator or put counsel's advice in it.
  It deletes the list's entries, everything calibration sampled from it (as a lead list or as a frame) with its labels, and its file `seeds/<id>.json` in the backup bucket.
  If the answer says `"file": "kept"`, the bucket refused the delete, which a bucket lock from before `seeds/` was left unlocked would do for 7 days after upload: delete it by hand then with `pnpm -C api exec wrangler r2 object delete colander-backups/seeds/<id>.json --remote`.
  Then set its clearance to `revoked` in the registry; the daily `seeds` job would also delete its entries and samples within a day of that deploy.
- Build the calibration set (step 20, D5): command `calibration-sample` with args such as `{"frame": "seed:cevval-yt-ai-music", "n": 150}`, `{"frame": "community", "n": 150}` or `{"frame": "random:tubecensus-sample", "n": 300}`.
  The `random:` frame reads its own object, `seeds/tubecensus-sample.json`, with the sampled channel IDs one per line, like an import.
  Curators and staff label at `/console/calibration`, recording for each source they can judge its language and whether it is mostly music, which the report groups by; staff give the third label where two disagree at `/admin/calibration` on the admin host.
  To report, run command `calibration-export`, fetch the file it names with `pnpm -C api exec wrangler r2 object get colander-backups/<key> --file export.json --remote`, and run `node scripts/calibration-report.ts export.json`.
  The export names channels, so delete `export.json` once the report is done; the report itself holds counts only.
- See the Store's health: command `status`.

### Restore

Point-in-time restore covers the last 30 days:
1. Pick the last good moment, for example `2026-11-02T14:05:00Z`.
2. Run Ops with command `pitr-restore`, args `{"at": "2026-11-02T14:05:00Z"}` and confirm `2026-11-02T14:05:00Z`.
3. The answer holds an undo bookmark; keep it from the run summary (the backup bucket keeps it too, under `pitr/`).
4. The Store restarts on the restored data, publishes a list sequence above any that installs hold, and the edge cache is purged.
5. Everyone signs in again and reconnects the side panel, and no credential or role taken away since comes back; grant again any role raised after the restore point, and issue again any passkey invite still open.

If the Store namespace itself is gone, restore the newest dump from the backup bucket:
1. Find the newest dump's key: run Ops with command `drill`, whose answer names it as `key` even when the empty Store fails the comparison, or browse the `dumps/` prefix of the backup bucket in the Cloudflare dashboard (the bootstrap script prints the bucket names; Wrangler has no command that lists objects).
2. Run Ops with command `restore-dump`, args `{"key": "<dump key>"}` and confirm set to the same key.
3. As after a point-in-time restore, everyone signs in again; grant again any role raised after the dump, and issue again any passkey invite still open.

Until then the empty Store publishes nothing: it never puts an empty list above the one in R2, which every install would take, and the watchdog alerts `store_empty`.
To start from an empty list on purpose instead (a reset staging environment), delete `list/snapshot.bin` from the lists bucket with `pnpm -C api exec wrangler r2 object delete <lists bucket>/list/snapshot.bin --remote`.

The monthly drill proves the point-in-time path on staging, and the weekly drill proves every dump loads.
Run either by hand from the Drills workflow.

### Dumps from before migration 5

Dumps taken before migration 5 (`0005_compliance.sql`) hold YouTube Data API data, which may not be kept 30 days, and seed list names that public pages no longer show.
Restoring one is still safe, because the restore runs that migration's data changes on its rows again.
If a Worker of either environment ran before its first deploy with migration 5, delete those dumps once they are out of the bucket lock:
1. Wait until a dump taken after the deploy has passed the weekly drill, and until the newest dump from before the deploy is over 7 days old.
2. In the Cloudflare dashboard, open the environment's backup bucket and delete every object under `dumps/` whose name is a time before the deploy, or delete each with `pnpm -C api exec wrangler r2 object delete <backup bucket>/<key> --remote`.

### Rotate the signing key

The extension trusts every key in `COLANDER_PUBLIC_KEYS`, so rotation never breaks an install that updated.
1. Make sure the current release build already trusts the next key (it does when `COLANDER_PUBLIC_KEYS` was "current,next" when it was built), and that the store has served that version for a few weeks.
2. Switch the Worker: `pnpm -C api exec wrangler secret put COLANDER_SIGNING_KEY < production-signing-next.key`.
   The next publication is signed with the new key.
3. Make a new next key with `node scripts/keygen.ts production-signing-next2.key` and set `COLANDER_PUBLIC_KEYS` to "new current,new next".
4. The next probe run checks the snapshot against the new list.
   The next extension release ships the new pair.

### Rotate credentials

| Credential | How often | How |
| --- | --- | --- |
| Cloudflare API tokens | yearly, before expiry | Roll the token in Manage account > Account API tokens and update `CLOUDFLARE_API_TOKEN` in its environment |
| Access service token | yearly, before expiry | Zero Trust > Service Tokens > Rotate secret with a grace period, then update `CF_ACCESS_CLIENT_SECRET` |
| Staff keys | when one is lost | Step 6a, Recovery |
| GitHub App private key | yearly | Generate a new key in the App settings, update `RELEASE_APP_PRIVATE_KEY`, delete the old key |
| Edge Add-ons API key | within 72 days, which is when it expires | In Partner Center, Microsoft Edge, Publish API, create a new key before the old one expires (several can exist at once), update `EDGE_API_KEY`, then delete the old one. The weekly probe opens an issue named "Edge Add-ons API key refused" once a key stops working. |
| AMO API key | when it leaks or a maintainer leaves | Regenerate it at https://addons.mozilla.org/developers/addon/api/key/ and update `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` |

Google publishing is keyless and has nothing to rotate.

### Account recovery

- A member who lost a passkey signs in with an email code; removing the lost passkey with only a code waits 72 hours, then they add a new one.
- A member who lost their mailbox writes to support. If they paid, ask for the Checkout Session ID on their Stripe receipt, the amount and the charge date, then on the admin host open People, find the account and use Change email (admins only).
  The move waits 7 days with a cancel link to the old address, then ends every session, passkey and token. Members who never paid create a new account.
- Curators, staff and admins are never moved to a new address: make the new address the reviewer instead, and issue an invite.
- A reviewer who lost their passkey still signs in with a code with member rights; check who they are through another channel, then issue a new invite.
- Admins remove a donor's supporter credit by the Checkout Session ID on the receipt, through `POST /v1/admin/donations/{id}/credit` on the admin host.

### When something fails

- The watchdog cron mails the alert address when the scoring pass, the list publication, R2 or the dumps fall behind, and when more than 500 sign-in codes go out in an hour (`sign_in_mail`): check the audit log and turn on Turnstile (step 6b).
- It also mails `pair_guessing` when 300 or more wrong pairing codes come in within an hour from all addresses together, which looks like someone guessing codes.
  Claims stay limited per address either way; look for `POST /v1/pair/claim` in the edge logs.
- `probes.yml`, `drills.yml` and `adapters-daily.yml` open an issue named after the failing check, or comment on the open one.
  Close the issue once the cause is fixed.
- GitHub turns off scheduled workflows after 60 days without activity in a public repository, so re-enable them under Actions if the repository goes quiet.
- `cf-cache-status` misses in the smoke test mean Workers Cache is off or bypassed; check `cache` in `api/wrangler.jsonc`.
