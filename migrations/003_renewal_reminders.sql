-- Renewal nudges (1.1.0): warn the household *before* a subscription bills,
-- while cancelling is still an option.
--
-- One switch, two delivery channels. `remind`/`lead_days` describe the nudge
-- the household wants; how it arrives is the household's choice:
--   • free    — the app publishes `subscription.renewal_upcoming`, which an
--               automation rule can turn into a calendar entry on `remind_on`.
--   • premium — the hub's `date_reminders` cron emails the same nudge
--               (manifest `date_reminders` block; needs cron + email).
-- Both read the same two columns, so a household never configures the nudge
-- twice and the two channels can never disagree about the date.
--
-- Defaults are "remind me, a week out": a subscription is tracked precisely so
-- its renewal doesn't arrive unannounced, and 7 days is enough notice to
-- cancel. Rows that existed before this migration inherit that default.
--
-- The column DEFAULT is the *floor* (5), not the taste value (7), because a
-- DEFAULT is a constant and the safe lead time is not: a weekly subscription
-- cannot carry a 7-day lead without going permanently silent (maxLeadDays() in
-- logic.js explains why — the hub's `lead_days + 1` dedupe window would be
-- wider than the billing period). Any INSERT that omits the column — notably
-- the `add_subscription` automation action, which knows the period only as a
-- runtime param — therefore lands on a value every period can honor. The
-- backfill below then raises the existing non-weekly rows to 7.
ALTER TABLE app_subscriptions__subscriptions ADD COLUMN remind INTEGER NOT NULL DEFAULT 1;
ALTER TABLE app_subscriptions__subscriptions ADD COLUMN lead_days INTEGER NOT NULL DEFAULT 5;

-- Backfill. `status` and `billing_period` are plaintext (the hub's skip-list
-- and db_plaintext_columns respectively), so both are readable here — app
-- migrations run outside the field codec and could not match an encrypted one.
--
-- A cancelled subscription does not renew, so it must not be nudged about a
-- renewal: `date_reminders` has no status filter, it only reads `remind`, so
-- "cancelled" has to be expressed AS remind = 0 or the cron would mail
-- "Netflix renews in 7 days" for a service dropped months ago. saveSub() keeps
-- the two in step from here on by forcing remind = 0 whenever status is
-- cancelled.
UPDATE app_subscriptions__subscriptions
   SET remind = CASE WHEN status = 'cancelled' THEN 0 ELSE 1 END,
       lead_days = CASE billing_period WHEN 'weekly' THEN 5 ELSE 7 END;

-- Who the *email* reaches. The row itself is household-readable (nothing about
-- "we pay for Spotify" is secret), but a renewal notice is a bill, and a bill
-- is the payer's business — so the default is the payer alone, and the hub's
-- date_reminders `visibility_column` reads this column to decide. 'household'
-- widens it to every member with an email. With no payer recorded, the payer
-- audience resolves to nobody and `on_no_recipients: "adults"` catches it.
--
-- This governs email only; it is not an access control. A member who can read
-- the row can still see the renewal date in the app either way.
ALTER TABLE app_subscriptions__subscriptions ADD COLUMN remind_scope TEXT NOT NULL DEFAULT 'payer';

-- Dedupe stamp written by the hub cron after a row's reminder is emailed (the
-- `_at` suffix keeps it plaintext). The durable authority is the hub's own
-- per-recipient send log, keyed by occurrence; this column exists so the app
-- can display "already sent" and so fully-served rows drop out of evaluation.
--
-- The app clears it when the renewal date moves (see markRenewed): the hub
-- suppresses a row whose stamp falls inside the *current* occurrence's
-- lead-days window, and for a weekly subscription consecutive occurrences are
-- closer together than a generous window is wide — last cycle's stamp would
-- silence this cycle forever. Clearing cannot cause a duplicate send; the send
-- log still holds the previous occurrence.
ALTER TABLE app_subscriptions__subscriptions ADD COLUMN last_reminded_at TEXT;
