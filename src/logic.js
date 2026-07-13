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
  { value: "weekly",  label: "Weekly",  perYear: 52 },
  { value: "monthly", label: "Monthly", perYear: 12 },
  { value: "yearly",  label: "Yearly",  perYear: 1 },
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

/** Parse a user-entered dollar amount ("9.99", "$120") to integer cents; null if invalid. */
export function parseMoneyToCents(raw) {
  const s = String(raw ?? "").replace(/[$,\s]/g, "");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}
