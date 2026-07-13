import { describe, it, expect } from "vitest";
import {
  categoryMeta, periodMeta, monthlyCostCents, totalMonthlyCents, totalYearlyCents,
  daysUntilDate, advanceRenewal, renewalLabel, sortedSubscriptions, parseMoneyToCents,
} from "../src/logic.js";

const FROM = new Date(2026, 6, 12, 9, 0, 0); // July 12, 2026 local

describe("cost normalization", () => {
  it("normalizes each period to monthly cents", () => {
    expect(monthlyCostCents({ amount_cents: 1200, billing_period: "monthly" })).toBe(1200);
    expect(monthlyCostCents({ amount_cents: 12000, billing_period: "yearly" })).toBe(1000);
    expect(monthlyCostCents({ amount_cents: 300, billing_period: "weekly" })).toBe(1300);
  });
  it("totals only active subscriptions", () => {
    const subs = [
      { amount_cents: 1000, billing_period: "monthly", status: "active" },
      { amount_cents: 99999, billing_period: "monthly", status: "cancelled" },
    ];
    expect(totalMonthlyCents(subs)).toBe(1000);
    expect(totalYearlyCents(subs)).toBe(12000);
  });
});

describe("daysUntilDate", () => {
  it("counts calendar days and signs overdue", () => {
    expect(daysUntilDate("2026-07-12", FROM)).toBe(0);
    expect(daysUntilDate("2026-07-20", FROM)).toBe(8);
    expect(daysUntilDate("2026-07-10", FROM)).toBe(-2);
    expect(daysUntilDate("", FROM)).toBeNull();
  });
});

describe("advanceRenewal", () => {
  it("rolls forward one period past today", () => {
    expect(advanceRenewal("2026-07-12", "monthly", FROM)).toBe("2026-08-12");
    expect(advanceRenewal("2026-07-05", "weekly", FROM)).toBe("2026-07-19");
    expect(advanceRenewal("2026-07-01", "yearly", FROM)).toBe("2027-07-01");
  });
  it("catches up when the date is far in the past (first occurrence after today)", () => {
    expect(advanceRenewal("2026-01-15", "monthly", FROM)).toBe("2026-07-15");
  });
  it("keeps the anchor day across short months", () => {
    // Jan 31 monthly → next after Feb (clamped) then back to 31 in March
    expect(advanceRenewal("2026-01-31", "monthly", new Date(2026, 1, 15))).toBe("2026-02-28");
  });
  it("returns input unchanged for garbage", () => {
    expect(advanceRenewal("nope", "monthly", FROM)).toBe("nope");
  });
});

describe("renewalLabel", () => {
  it("labels today/tomorrow/overdue", () => {
    expect(renewalLabel(0)).toBe("Today");
    expect(renewalLabel(1)).toBe("Tomorrow");
    expect(renewalLabel(-3)).toBe("3 days overdue");
    expect(renewalLabel(null)).toBe("—");
  });
});

describe("sortedSubscriptions", () => {
  it("puts soonest renewal first and cancelled last", () => {
    const subs = [
      { id: "a", name: "A", status: "active", next_renewal_date: "2026-08-01" },
      { id: "b", name: "B", status: "cancelled", next_renewal_date: "2026-07-13" },
      { id: "c", name: "C", status: "active", next_renewal_date: "2026-07-14" },
    ];
    expect(sortedSubscriptions(subs, FROM).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });
});

describe("parseMoneyToCents", () => {
  it("parses dollars to integer cents", () => {
    expect(parseMoneyToCents("15.49")).toBe(1549);
    expect(parseMoneyToCents("$120")).toBe(12000);
    expect(parseMoneyToCents("x")).toBeNull();
  });
});

describe("meta fallbacks", () => {
  it("unknown category/period fall back safely", () => {
    expect(categoryMeta("bogus").value).toBe("other");
    expect(periodMeta("bogus").value).toBe("monthly");
  });
});
