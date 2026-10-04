# Deploying and running Colander

This is the owner's runbook for Colander on Cloudflare.
The design and its reasons are in [hosting-plan.md](hosting-plan.md); every wire format is in [contracts.md](contracts.md).
Part 1 is the one-time setup, in the order to do it.
Part 2 is the reference for secrets, variables and the ops channel.
Part 3 is day-2 operations.

## How it fits together

| Environment | Origin | Worker | Deployed by |
| --- | --- | --- | --- |
| production | https://getcolander.com | `colander` | `release.yml`, when you merge a release PR |
| staging | https://staging.getcolander.com, behind Cloudflare Access | `colander-staging` | `deploy-staging.yml`, after every green CI run on main |
| Chrome Web Store | the store item | - | `release.yml`, as a staged publish |

The Worker names come from `api/wrangler.jsonc`; this runbook assumes the top level is production and `env.staging` is staging.
GitHub Actions is the only pipeline, and Workers Builds stays off.

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every pull request and push to main | The required checks: `secrets`, `workflows`, `api`, `contract`, `web-and-extension`, `full-stack` |
| `deploy-staging.yml` | CI succeeded on main | Builds, deploys staging, runs the mutating smoke test, records a GitHub deployment for the commit |
| `release.yml` | push to main | release-please; on a platform release, production deploy after staging passed the same commit, smoke test, automatic rollback; on an extension release, the store package with provenance and a staged Chrome Web Store submission |
| `rollback.yml` | by hand | Puts an earlier Worker version back live |
| `ops.yml` | by hand | One command on the ops channel |
| `probes.yml` | hourly at :41 | Read-only production smoke test and `/ops/status` thresholds; opens an issue on failure |
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
2. Leave the zone's DNS empty for the apex and `staging`: the first deploy in step 9 creates both records as Worker Custom Domains.

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

### 8. R2 buckets and Worker secrets

Before you start, have two things ready: the `colander-analytics` token from step 10 (it is a Worker secret), and the GitHub repository with its three environments from step 15 (the `OPS_TOKEN` lines write to them).
1. Log Wrangler in as the owner: `pnpm -C api exec wrangler login`.
2. Run `scripts/cloudflare-bootstrap.sh`.
   It reads the R2 bindings of both environments from `api/wrangler.jsonc`, creates the list and backup buckets with the `enam` location hint, sets lifecycle rules (backups expire after 90 days, unfinished multipart uploads after a day), and puts a 7-day bucket lock on the backup buckets.
   It is safe to run again.
3. Run every secret command the script prints, for production and for staging.
   They read values from stdin, so nothing lands in shell history.
   The `OPS_TOKEN` lines store the same value as a Worker secret and as a GitHub environment secret, so `gh` must be logged in.
4. Check with `pnpm -C api exec wrangler secret list` and `pnpm -C api exec wrangler secret list --env staging`.

### 9. The first deploy of each environment

The first deploy attaches the Custom Domains and creates the Store's Durable Object namespace, which needs more rights than CI tokens get.
Do it once from your machine, still logged in as the owner:

```sh
PUBLIC_EXTENSION_ID=nninnogmbhfebflkcgghlmjmplmpodlc pnpm -C web build
pnpm -C api exec wrangler deploy --env staging
pnpm -C web build    # the release workflow later rebuilds it with the store item ID
pnpm -C api exec wrangler deploy
```

Then check both with the smoke test (step 16 explains the reviewer token for the mutating run):

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
2. Create an API key restricted to that API.
3. Put it in the `YOUTUBE_API_KEY` Worker secret of both environments (step 8).

### 13. Chrome Web Store developer account and item

The API cannot create items, so the first package goes up by hand.
1. Register as a Chrome Web Store developer with the publishing Google account, and turn on 2-step verification for it.
2. Build a store package for the first upload; store builds carry no manifest key, which the store rejects:

   ```sh
   WXT_COLANDER_API=https://getcolander.com WXT_COLANDER_SITE=https://getcolander.com \
   WXT_COLANDER_PUBLIC_KEYS=<COLANDER_PUBLIC_KEYS> WXT_COLANDER_STORE_BUILD=1 pnpm -C extension zip
   ```

3. In the Developer Dashboard select Add new item and upload `extension/dist/colanderextension-1.0.0-chrome.zip`.
4. Fill in the Store listing with a descriptive title such as "Colander - Hide AI Slop", and the Privacy tab.
5. Copy the item ID (it is the extension ID) and the publisher ID from Account > Publisher settings.
   They become the variables `CWS_ITEM_ID` (repository) and `CWS_PUBLISHER_ID` (environment `chrome-web-store`).
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
These are the exact check names, one per CI job: `secrets`, `workflows`, `api`, `contract`, `web-and-extension`, `full-stack`.

```sh
gh api -X POST repos/rudecompany/colander/rulesets --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0, "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false, "require_last_push_approval": false,
        "required_review_thread_resolution": true, "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "secrets", "integration_id": 15368 },
          { "context": "workflows", "integration_id": 15368 },
          { "context": "api", "integration_id": 15368 },
          { "context": "contract", "integration_id": 15368 },
          { "context": "web-and-extension", "integration_id": 15368 },
          { "context": "full-stack", "integration_id": 15368 } ] } }
  ]
}
JSON
```

`15368` is the GitHub Actions app, so only Actions can satisfy these checks.

**Immutable releases.**
`gh api -X PUT repos/rudecompany/colander/immutable-releases`.
release-please makes draft releases; the workflows attach assets and then publish them, after which nothing about a release can change.

**The release-please GitHub App.**
Releases are proposed by a GitHub App, because pull requests opened with the workflow token do not run CI, and the required checks would never pass.
1. Create a GitHub App owned by `rudecompany` named `colander-release`, with webhooks off, and repository permissions Contents: Read and write, Pull requests: Read and write, Issues: Read and write.
2. Install it on `rudecompany/colander` only.
3. Store its Client ID as the repository variable `RELEASE_APP_CLIENT_ID`, generate a private key, and store the whole PEM as the repository secret `RELEASE_APP_PRIVATE_KEY`.

**Environments.**
Create the three environments, each limited to deployments from main:

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

### 16. The staging smoke account

The staging smoke test makes a staff decision and checks that it reaches the edge within 60 seconds, so it needs a staff reviewer token.
1. Grant the role on staging: run the Ops workflow with environment `staging`, command `grant-role` and args `{"email": "smoke@getcolander.com", "role": "staff"}`.
2. Sign in on https://staging.getcolander.com/account as that address.
3. In the browser console on that page run `await (await fetch('/v1/account/reviewer-token', {method: 'POST', headers: {'X-Colander-CSRF': '1'}})).json()`.
4. Store the token as the `staging` environment secret `STAGING_REVIEWER_TOKEN`.
   Requesting a new token replaces the old one, so use this account for nothing else.

### 17. Check the whole path

1. Merge a small `fix:` pull request.
   CI passes, `deploy-staging` deploys it and its smoke test passes.
2. release-please opens a release PR; merge it.
   `release.yml` waits for staging, deploys production, smoke-tests it and publishes the release `v1.0.1`.
3. Run the Probes workflow by hand and check that it passes.

## Part 2: reference

### Secrets and variables

| Name | Kind | Where | Value |
| --- | --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | variable | repository | Cloudflare account ID |
| `COLANDER_PUBLIC_KEYS` | variable | repository | Production public key, comma, next public key (step 7) |
| `CWS_ITEM_ID` | variable | repository | Chrome Web Store item ID, which is also the extension ID |
| `RELEASE_APP_CLIENT_ID` | variable | repository | Client ID of the `colander-release` GitHub App |
| `RELEASE_APP_PRIVATE_KEY` | secret | repository | Private key PEM of that App |
| `CLOUDFLARE_API_TOKEN` | secret | `staging` | `colander-ci-staging` token |
| `CF_ACCESS_CLIENT_ID` | secret | `staging` | Access service token Client ID |
| `CF_ACCESS_CLIENT_SECRET` | secret | `staging` | Access service token Client Secret |
| `OPS_TOKEN` | secret | `staging` | Same value as the staging Worker secret `OPS_TOKEN` |
| `STAGING_REVIEWER_TOKEN` | secret | `staging` | Reviewer token of the staging smoke account (step 16) |
| `STAGING_PUBLIC_KEYS` | variable | `staging` | Staging public key |
| `CLOUDFLARE_API_TOKEN` | secret | `production` | `colander-ci-production` token |
| `OPS_TOKEN` | secret | `production` | Same value as the production Worker secret `OPS_TOKEN` |
| `CWS_PUBLISHER_ID` | variable | `chrome-web-store` | Chrome Web Store publisher ID |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | variable | `chrome-web-store` | Full provider name from step 14 |
| `GCP_SERVICE_ACCOUNT` | variable | `chrome-web-store` | `cws-publisher@<project>.iam.gserviceaccount.com` |

Worker secrets, per environment, set with `wrangler secret put` and never stored in GitHub except `OPS_TOKEN`: `COLANDER_SIGNING_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `YOUTUBE_API_KEY`, `RESEND_API_KEY`, `CF_ANALYTICS_TOKEN`, `IP_SALT`, `OPS_TOKEN`.
`.github/actionlint.yaml` lists every variable the workflows read, so CI fails on a misspelled one.

### The ops channel

The workflows talk to the Worker through one authenticated channel, and the Worker must implement exactly this:
- Request: `POST /ops/<command>` with `Authorization: Bearer <OPS_TOKEN>`, `Content-Type: application/json` and a JSON object body.
  The Worker compares the token in constant time and answers 401 without detail when it is wrong.
- Response: JSON.
  Any 2xx status means the command succeeded; anything else means it failed, with a contract error body.
- On staging the requests also carry the Access service token headers.

| Command | Body | Success answer |
| --- | --- | --- |
| `status` | `{}` | `head_seq` (Store list head), `r2_seq` (sequence in R2's `list/snapshot.bin`), `pass_age_s` (seconds since the last completed scoring pass), `publish_lag_s` (seconds the oldest verdict change not yet in R2's list has waited, 0 when R2 holds the head), `dump_age_s` (seconds since the newest successful dump), `dump_ms`, `rows_read_last_pass` |
| `grant-role` | `{"email", "role"}` with role `member`, `curator` or `staff` | The account |
| `import-seed` | `{"file", "list", "source_name", "license", "accept_license": true}`, file being the list text | Counts imported |
| `sign-config` | `{"file"}`, file being the adapter configuration JSON, signed byte for byte | Version and key ID |
| `drill` | `{}` | `{"ok": true, ...}` after the dump drill passed (hosting plan section 3) |
| `purge-cache` | `{"confirm": "purge-cache"}` | Done |
| `restore-dump` | `{"key", "confirm"}`, confirm equal to key | Done |
| `pitr-restore` | `{"at", "confirm"}`, `at` an RFC 3339 time and confirm equal to it | The bookmark and the undo bookmark, also kept in the backup bucket under `pitr/` |

The probes require `pass_age_s` under 900, `dump_age_s` under 25,200 and `publish_lag_s` under 21,600.
The restore drill (`scripts/pitr-drill.ts`) uses `head_seq` and `r2_seq`.

## Part 3: day-2 operations

### Deploy

1. Merge a pull request to main; its title is its commit message, in Conventional Commits form.
2. CI runs on main, and `deploy-staging` deploys the commit to staging and smoke-tests it.
3. release-please keeps a release PR open with the next versions and changelogs; never edit a CHANGELOG.md by hand.
4. Merging the release PR deploys production: `release.yml` waits until staging passed that commit, records the live version, runs `wrangler deploy --tag vX.Y.Z`, smoke-tests production read-only, and publishes the release.
   If the smoke test fails it rolls back to the recorded version and the job fails.
5. An extension release (a change under `extension/`) builds the store package, attests it, attaches it to the `extension-vX.Y.Z` release and submits it as a staged publish.
   After review, publish it from the Developer Dashboard once the backend it needs is live in production.

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
- Ship new adapter selectors: raise `version` in `extension/src/adapters/default-config.json`, merge it, then run command `sign-config` with that file.
- Import a seed list: commit it, then command `import-seed` with file set to its path and args `{"list": "blocklist", "source_name": "AiSList", "license": "CC BY-NC 4.0", "accept_license": true}`.
- See the Store's health: command `status`.

### Restore

Point-in-time restore covers the last 30 days:
1. Pick the last good moment, for example `2026-11-02T14:05:00Z`.
2. Run Ops with command `pitr-restore`, args `{"at": "2026-11-02T14:05:00Z"}` and confirm `2026-11-02T14:05:00Z`.
3. The answer holds an undo bookmark; keep it from the run summary (the backup bucket keeps it too, under `pitr/`).
4. The Store restarts on the restored data, publishes a list sequence above any that installs hold, and the edge cache is purged.

If the Store namespace itself is gone, restore the newest dump from the backup bucket:
1. Find the newest dump's key: run Ops with command `drill`, whose answer names it as `key` even when the empty Store fails the comparison, or browse the `dumps/` prefix of the backup bucket in the Cloudflare dashboard (the bootstrap script prints the bucket names; Wrangler has no command that lists objects).
2. Run Ops with command `restore-dump`, args `{"key": "<dump key>"}` and confirm set to the same key.

Until then the empty Store publishes nothing: it never puts an empty list above the one in R2, which every install would take, and the watchdog alerts `store_empty`.
To start from an empty list on purpose instead (a reset staging environment), delete `list/snapshot.bin` from the lists bucket with `pnpm -C api exec wrangler r2 object delete <lists bucket>/list/snapshot.bin --remote`.

The monthly drill proves the point-in-time path on staging, and the weekly drill proves every dump loads.
Run either by hand from the Drills workflow.

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
| `OPS_TOKEN` | quarterly | Run the two `OPS_TOKEN` lines the bootstrap script prints, for each environment |
| Cloudflare API tokens | yearly, before expiry | Roll the token in Manage account > Account API tokens and update `CLOUDFLARE_API_TOKEN` in its environment |
| Access service token | yearly, before expiry | Zero Trust > Service Tokens > Rotate secret with a grace period, then update `CF_ACCESS_CLIENT_SECRET` |
| `STAGING_REVIEWER_TOKEN` | when it stops working | Step 16 again |
| GitHub App private key | yearly | Generate a new key in the App settings, update `RELEASE_APP_PRIVATE_KEY`, delete the old key |

Google publishing is keyless and has nothing to rotate.

### When something fails

- The watchdog cron mails the alert address when the scoring pass, the list publication, R2 or the dumps fall behind.
- `probes.yml`, `drills.yml` and `adapters-daily.yml` open an issue named after the failing check, or comment on the open one.
  Close the issue once the cause is fixed.
- GitHub turns off scheduled workflows after 60 days without activity in a public repository, so re-enable them under Actions if the repository goes quiet.
- `cf-cache-status` misses in the smoke test mean Workers Cache is off or bypassed; check `cache` in `api/wrangler.jsonc`.
