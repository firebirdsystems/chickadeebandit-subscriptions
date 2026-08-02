-- Automation support for the `add_subscription` action.
--
-- `source_event_id` records which app event produced the row. The dispatcher's
-- dedupe guard matches on it (SELECT 1 FROM ... WHERE source_event_id = ?
-- LIMIT 1), so a redelivered event reuses the subscription already tracked
-- instead of double-counting a recurring cost.
--
-- Nullable on purpose: subscriptions entered by hand have no source event, and
-- the guard only ever looks for a specific non-null id.
ALTER TABLE app_subscriptions__subscriptions ADD COLUMN source_event_id TEXT;

CREATE INDEX IF NOT EXISTS app_subscriptions__idx_subscriptions_source_event_id
  ON app_subscriptions__subscriptions(source_event_id);
