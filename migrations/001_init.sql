-- Subscriptions & Bills — the household's recurring payments in one list.
--
-- Access: `subscriptions` is `adult_writable` (manifest.json) — every member
-- may read (nothing here is secret; "we pay for Spotify" is household
-- knowledge), only adults manage rows.
--
-- Money is integer minor units (`amount_cents`). `billing_period` and
-- `next_renewal_date` are declared plaintext (manifest db_plaintext_columns)
-- because the AI export and the app sort/filter on them; `status` and
-- `category` are already on the hub's plaintext skip-list. The name, url, and
-- notes stay encrypted at rest and are only displayed.
CREATE TABLE IF NOT EXISTS app_subscriptions__subscriptions (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,                        -- "Netflix"
  category          TEXT NOT NULL DEFAULT 'other',        -- streaming|software|memberships|utilities|insurance|other
  amount_cents      INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  billing_period    TEXT NOT NULL DEFAULT 'monthly',      -- weekly|monthly|yearly
  next_renewal_date TEXT NOT NULL DEFAULT '',             -- ISO YYYY-MM-DD
  payer_id          TEXT NOT NULL DEFAULT '',             -- member who pays (optional)
  status            TEXT NOT NULL DEFAULT 'active',       -- active|cancelled
  url               TEXT NOT NULL DEFAULT '',             -- manage/cancel link (display only)
  notes             TEXT NOT NULL DEFAULT '',
  created_by        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS app_subscriptions__subscriptions_renewal_idx
  ON app_subscriptions__subscriptions (status, next_renewal_date);
