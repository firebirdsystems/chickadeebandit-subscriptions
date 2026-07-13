-- AI read export: active subscriptions ordered by next renewal.
-- adult_writable reads are open, so no member_id is required.
-- status is built-in plaintext; billing_period and next_renewal_date are
-- declared in db_plaintext_columns, so the WHERE/ORDER BY work in SQL.
-- amount_cents is integer minor units.
SELECT
  id,
  name,
  category,
  amount_cents,
  billing_period,
  next_renewal_date,
  payer_id,
  notes
FROM app_subscriptions__subscriptions
WHERE status = 'active'
ORDER BY next_renewal_date
LIMIT 200
