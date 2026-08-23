/**
 * Pure business logic for the Subscriptions & Bills app.
 * No DOM, no fetch — importable in both browser and test environments.
 */

export const CATEGORIES = [
  { value: "streaming",   label: "Streaming",   icon: "📺" },
  { value: "software",    label: "Software",    icon: "💻" },
  { value: "memberships", label: "Memberships", icon: "🏋️" },
  { value: "utilities",   label: "Utilities",   icon: "💡" },
  { value: "insurance",   label: "Insurance",   icon: "🛡️" },
  { value: "other",       label: "Other",       icon: "📌" },
];

export const PERIODS = [
  // `maxLead` is a correctness limit, not taste — see maxLeadDays().
  { value: "weekly",  label: "Weekly",  perYear: 52, maxLead: 5 },
  { value: "monthly", label: "Monthly", perYear: 12, maxLead: 26 },
  { value: "yearly",  label: "Yearly",  perYear: 1,  maxLead: 90 },
];

/** Days before a renewal that a nudge fires when nothing else is chosen. Long
 *  enough to actually cancel, short enough to still feel imminent. Always run
 *  through clampLeadDays(), which lowers it for periods that can't carry it (a
 *  weekly subscription can't be warned about a week ahead — see maxLeadDays).
 *
 *  Deliberately NOT mirrored by manifest date_reminders.default_lead_days: that
 *  value is applied by the hub with no clamp and no knowledge of the period, so
 *  it carries the floor (5) instead. Same reasoning as the column DEFAULT in
 *  migration 003. */
export const DEFAULT_LEAD_DAYS = 7;

export const LEAD_CHOICES = [1, 3, 7, 14, 30];

/** Who a renewal *email* goes to. Not an access control — the row stays
 *  household-readable either way; see migration 003. */
export const REMIND_SCOPES = [
  { value: "payer",     label: "Just the payer" },
  { value: "household", label: "Everyone" },
];

const CAT_BY_VALUE = new Map(CATEGORIES.map((c) => [c.value, c]));
const PERIOD_BY_VALUE = new Map(PERIODS.map((p) => [p.value, p]));

export function categoryMeta(v) {
  return CAT_BY_VALUE.get(v) ?? { value: "other", label: "Other", icon: "📌" };
}

export function periodMeta(v) {
  return PERIOD_BY_VALUE.get(v) ?? PERIOD_BY_VALUE.get("monthly");
}

/** Normalized monthly cost in cents for one subscription (integer, rounded). */
export function monthlyCostCents(sub) {
  const amount = Number(sub.amount_cents);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const perYear = periodMeta(sub.billing_period).perYear;
  return Math.round((amount * perYear) / 12);
}

/** Sum of normalized monthly cost across active subscriptions. */
export function totalMonthlyCents(subs) {
  return subs.filter((s) => s.status === "active").reduce((sum, s) => sum + monthlyCostCents(s), 0);
}

/** Sum of the true annual cost across active subscriptions. */
export function totalYearlyCents(subs) {
  return subs
    .filter((s) => s.status === "active")
    .reduce((sum, s) => {
      const amount = Number(s.amount_cents);
      if (!Number.isFinite(amount) || amount <= 0) return sum;
      return sum + amount * periodMeta(s.billing_period).perYear;
    }, 0);
}

function atMidnight(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Whole days from `from` until an ISO date (negative = overdue). Null if unset. */
export function daysUntilDate(iso, from = new Date()) {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((atMidnight(d) - atMidnight(from)) / 86400000);
}

/**
 * Advance an ISO renewal date by its billing period until it lands strictly
 * after `from` (used by "mark paid" so the next date is always in the future).
 * Monthly/yearly keep the day-of-month, clamped to the target month's length.
 */
export function advanceRenewal(iso, period, from = new Date()) {
  let d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const today = atMidnight(from);
  const anchorDay = d.getDate();
  let guard = 0;
  while (atMidnight(d) <= today && guard++ < 400) {
    if (period === "weekly") {
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7, 12);
    } else if (period === "yearly") {
      d = clampedDate(d.getFullYear() + 1, d.getMonth(), anchorDay);
    } else {
      d = clampedDate(d.getFullYear(), d.getMonth() + 1, anchorDay);
    }
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clampedDate(year, monthIndex, day) {
  const daysInTarget = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(day, daysInTarget), 12);
}

/** "Today" / "Tomorrow" / "In 12 days" / "3 days overdue" / "—". */
export function renewalLabel(days) {
  if (days == null) return "—";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 31) return `In ${days} days`;
  if (days < 365) return `In ${Math.round(days / 30)} months`;
  return "In a year";
}

/** Active subs decorated with countdown, soonest renewal first; cancelled last. */
export function sortedSubscriptions(subs, from = new Date()) {
  return [...subs]
    .map((s) => ({ ...s, _days: daysUntilDate(s.next_renewal_date, from) }))
    .sort((a, b) => {
      if ((a.status === "cancelled") !== (b.status === "cancelled")) return a.status === "cancelled" ? 1 : -1;
      const da = a._days ?? Infinity;
      const db = b._days ?? Infinity;
      return da - db || String(a.name).localeCompare(String(b.name));
    });
}

/* ── Renewal nudges ──────────────────────────────────────────────────────────
 * One lead time drives both delivery channels: the calendar entry an
 * automation rule creates from `subscription.renewal_upcoming`, and the hub's
 * date_reminders email. Keeping the arithmetic here keeps them identical.
 */

/**
 * The largest lead time a billing period can carry.
 *
 * The hub suppresses a reminder whose `last_reminded_at` stamp falls inside the
 * current occurrence's window, which opens `lead_days + 1` days before the
 * date. If that window is wider than the gap between two renewals, the stamp
 * from the previous cycle always lands inside the next one's window and the
 * subscription goes quiet after its first nudge — a weekly subscription asked
 * for a week's notice would remind exactly once, ever. So each period caps its
 * lead at less than one period minus the window's day of timezone slop:
 * weekly 5 (< 7 - 1), monthly 26 (< 28 - 1, the shortest month), yearly 90 by
 * taste rather than necessity.
 *
 * The app also clears the stamp whenever the date moves, which fixes the same
 * hazard from the other side; the cap is what holds if a row is edited by hand
 * or reaches its next cycle some other way.
 */
export function maxLeadDays(period) {
  return periodMeta(period).maxLead;
}

/** A lead time coerced into range for its period. Invalid input falls back to
 *  the default (itself clamped), never to zero — zero would silently turn "warn
 *  me" into "warn me the morning it bills". */
export function clampLeadDays(days, period) {
  const max = maxLeadDays(period);
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1) return Math.min(DEFAULT_LEAD_DAYS, max);
  return Math.min(n, max);
}

/**
 * The lead choices offered for a period — those it can actually honor, plus the
 * period's own cap when no listed choice reaches it, plus `current` when the
 * row already carries a value the standard list doesn't contain.
 *
 * That last clause is not cosmetic. The picker doubles as the on/off switch,
 * with "No reminder" first, so an option list that fails to contain the current
 * value leaves NOTHING selected and the browser silently falls back to the
 * first option — turning "5 days before" into "No reminder" the moment the
 * period changes. It bites exactly the values that reach a row through a cap:
 * weekly's 5 becoming monthly (5 is not in LEAD_CHOICES), monthly's 26 becoming
 * yearly. Offering the value keeps the change the user made — the period — and
 * leaves the one they didn't touch alone.
 */
export function leadChoicesFor(period, current) {
  const max = maxLeadDays(period);
  const usable = LEAD_CHOICES.filter((d) => d <= max);
  if (!usable.includes(max)) usable.push(max);
  const cur = Math.floor(Number(current));
  if (Number.isFinite(cur) && cur >= 1 && cur <= max && !usable.includes(cur)) usable.push(cur);
  return usable.sort((a, b) => a - b);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08-29" → "Aug 29". Parsed as a plain calendar date, never a UTC
 *  instant, so it can't slide a day for a household west of Greenwich. */
export function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "");
  const month = Number(m[2]);
  if (month < 1 || month > 12) return iso;
  return `${MONTHS[month - 1]} ${Number(m[3])}`;
}

function isoOf(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The day the nudge is for: `lead_days` before the renewal, but never in the
 * past. A subscription added three days before it bills still deserves its
 * "decide now" entry — dated today, where it will actually be seen — rather
 * than one dated last week that no calendar will ever surface.
 *
 * Returns null when there is no usable renewal date.
 */
export function remindOnDate(nextRenewalIso, leadDays, period, from = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(nextRenewalIso ?? ""))) return null;
  const renewal = new Date(`${nextRenewalIso}T12:00:00`);
  if (Number.isNaN(renewal.getTime())) return null;
  const lead = clampLeadDays(leadDays, period);
  const remindOn = new Date(renewal.getFullYear(), renewal.getMonth(), renewal.getDate() - lead, 12);
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12);
  if (remindOn < today) return renewal < today ? null : isoOf(today);
  return isoOf(remindOn);
}

/** Calendar-entry title for the reminder day. Reads as the decision it is
 *  asking for, because that is what the day is for. */
export function reviewTitle(sub) {
  return `Keep or cancel: ${sub.name} (renews ${shortDate(sub.next_renewal_date)})`;
}

/** Second line of the calendar entry / reminder: what it costs and when. */
export function reviewSummary(sub, fmt) {
  const per = periodMeta(sub.billing_period);
  return `${fmt(Number(sub.amount_cents))} ${per.label.toLowerCase()} · renews ${shortDate(sub.next_renewal_date)}`;
}

/** Ledger description for a renewal booked into a budget app. */
export function renewalDescription(sub) {
  const per = periodMeta(sub.billing_period);
  return `${sub.name} (${per.label.toLowerCase()} subscription)`;
}

/**
 * Whether a subscription should announce an upcoming renewal at all.
 * Cancelled rows don't renew, un-nudged rows opted out, and a row with no
 * amount and no date has nothing to say.
 */
export function wantsRenewalNudge(sub) {
  return sub.status === "active"
    && Number(sub.remind) !== 0
    && /^\d{4}-\d{2}-\d{2}$/.test(String(sub.next_renewal_date ?? ""));
}

/**
 * Why an edit stopped a subscription from wanting a nudge, or null if it still
 * wants one (or never did). Drives `subscription.renewal_cancelled`, which lets
 * a rule take the entry back off the calendar.
 *
 * The transition is what matters, not the end state: a row that never announced
 * anything has nothing to retract, and publishing for one would spend an
 * automation run per save to update zero rows. So this returns null unless the
 * subscription *was* announcing and now is not.
 *
 * Status is checked before the reminder toggle because it is the more specific
 * answer when both changed — someone who cancels a subscription and clears its
 * reminder in one edit cancelled it; the toggle was housekeeping.
 */
export function nudgeRetractionReason(prev, next) {
  if (!prev || !wantsRenewalNudge(prev) || wantsRenewalNudge(next)) return null;
  if (next.status !== "active") return "cancelled";
  if (Number(next.remind) === 0) return "reminder_off";
  // The remaining way to stop wanting a nudge is losing a usable renewal date.
  // It retracts for the same reason the others do: the entry it put on the
  // calendar names a day that no longer means anything.
  return "cancelled";
}

/** Parse a user-entered dollar amount ("9.99", "$120") to integer cents; null if invalid. */
export function parseMoneyToCents(raw) {
  const s = String(raw ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

/**
 * Fields the in-app search matches against (see hub-sdk `searchMatch`).
 * Category and notes count as well as the name — "which streaming
 * ones renew in March" is a category question, and the account or
 * cancellation detail lives in the notes.
 */
export function searchableFields(item) {
  return [item.name, item.category, item.notes, item.url];
}
