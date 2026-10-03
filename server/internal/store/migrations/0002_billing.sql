-- Billing state (contracts 6.8), written only by internal/billing.
-- Scoring, tagging and review never read these tables: paying never changes a verdict.
-- No card data is ever stored; Stripe holds it.

-- Stripe events already handled, so a redelivered event is ignored.
CREATE TABLE billing_events (
	id          TEXT PRIMARY KEY, -- Stripe event id
	type        TEXT NOT NULL,
	received_at INTEGER NOT NULL
) STRICT;

-- Plus subscriptions, mirrored from Stripe.
CREATE TABLE subscriptions (
	id                   TEXT PRIMARY KEY, -- Stripe subscription id
	account_id           TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
	customer_id          TEXT NOT NULL,    -- Stripe customer, reused for the account's next checkout
	status               TEXT NOT NULL,    -- Stripe status: active, trialing, past_due, canceled, unpaid, ...
	interval             TEXT NOT NULL,    -- month | year
	period_start         INTEGER NOT NULL,
	period_end           INTEGER NOT NULL,
	cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
	latest_payment       TEXT,             -- PaymentIntent (or Charge) of the latest paid invoice, for refunds
	latest_paid_at       INTEGER,
	refunded_at          INTEGER,          -- when latest_payment was refunded
	created_at           INTEGER NOT NULL,
	updated_at           INTEGER NOT NULL
) STRICT;
CREATE INDEX subscriptions_account ON subscriptions (account_id);
CREATE INDEX subscriptions_payment ON subscriptions (latest_payment);

-- Donations, one row per completed Checkout Session. Donors need no account.
CREATE TABLE donations (
	id              TEXT PRIMARY KEY, -- Checkout Session id
	amount_cents    INTEGER NOT NULL,
	currency        TEXT NOT NULL,
	recurring       INTEGER NOT NULL, -- 1 for a monthly donation
	credit_name     TEXT,             -- shown on the supporters page when set
	payment         TEXT,             -- PaymentIntent of a one-time donation
	subscription_id TEXT,             -- Stripe subscription of a monthly donation
	refunded_at     INTEGER,
	created_at      INTEGER NOT NULL
) STRICT;
CREATE INDEX donations_payment ON donations (payment);
CREATE INDEX donations_credit ON donations (created_at) WHERE credit_name IS NOT NULL;
