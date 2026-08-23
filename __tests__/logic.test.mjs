import { describe, it, expect } from "vitest";
import {
  categoryMeta, periodMeta, monthlyCostCents, totalMonthlyCents, totalYearlyCents,
  daysUntilDate, advanceRenewal, renewalLabel, sortedSubscriptions, parseMoneyToCents, searchableFields,
  maxLeadDays, clampLeadDays, leadChoicesFor, remindOnDate, shortDate, reviewTitle,
  reviewSummary, renewalDescription, wantsRenewalNudge, nudgeRetractionReason, DEFAULT_LEAD_DAYS,
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

describe("lead times", () => {
  it("caps the lead at less than one billing period", () => {
    // The hub silences a row whose reminder stamp falls inside the current
    // occurrence's window (lead + 1 day). A 7-day lead on a weekly
    // subscription makes that window wider than the gap between renewals, so
    // the second cycle would never send.
    expect(maxLeadDays("weekly")).toBeLessThan(7 - 1);
    expect(maxLeadDays("monthly")).toBeLessThan(28 - 1);
    expect(clampLeadDays(7, "weekly")).toBe(5);
    expect(clampLeadDays(7, "monthly")).toBe(7);
  });
  it("falls back to the default lead rather than to zero", () => {
    // 0 would quietly turn "warn me" into "tell me the morning it bills".
    expect(clampLeadDays(0, "monthly")).toBe(DEFAULT_LEAD_DAYS);
    expect(clampLeadDays("nonsense", "monthly")).toBe(DEFAULT_LEAD_DAYS);
    expect(clampLeadDays(undefined, "weekly")).toBe(5);
  });
  it("only offers choices the period can honor", () => {
    expect(leadChoicesFor("weekly")).toEqual([1, 3, 5]);
    expect(leadChoicesFor("monthly")).toContain(14);
    expect(leadChoicesFor("monthly").every((d) => d <= maxLeadDays("monthly"))).toBe(true);
  });

  it("offers the row's current lead time even when the list omits it", () => {
    // The picker is also the on/off switch, with "No reminder" first. A list
    // that doesn't contain the selected value leaves nothing selected and the
    // browser falls back to the first option — a weekly→monthly edit would
    // silently write remind = 0. Every period a value can travel to must keep
    // offering it.
    expect(leadChoicesFor("monthly", 5)).toContain(5);
    expect(leadChoicesFor("monthly", 5)).toEqual([1, 3, 5, 7, 14, 26]);
    expect(leadChoicesFor("yearly", 26)).toContain(26);
    for (const from of ["weekly", "monthly", "yearly"]) {
      for (const to of ["weekly", "monthly", "yearly"]) {
        for (const choice of leadChoicesFor(from)) {
          const carried = clampLeadDays(choice, to);
          expect(leadChoicesFor(to, carried), `${from} ${choice} → ${to}`).toContain(carried);
        }
      }
    }
  });

  it("ignores a current value the period cannot honor", () => {
    // Out of range, so clampLeadDays would have lowered it anyway; offering it
    // would promise a lead time that silences the row.
    expect(leadChoicesFor("weekly", 30)).toEqual([1, 3, 5]);
    expect(leadChoicesFor("weekly", 0)).toEqual([1, 3, 5]);
    expect(leadChoicesFor("weekly", "nonsense")).toEqual([1, 3, 5]);
  });
});

describe("remindOnDate", () => {
  it("is the renewal minus the lead time", () => {
    expect(remindOnDate("2026-07-30", 7, "monthly", FROM)).toBe("2026-07-23");
    expect(remindOnDate("2026-08-01", 14, "monthly", FROM)).toBe("2026-07-18");
  });
  it("clamps a lead that reaches into the past to today", () => {
    // A subscription added three days before it bills still deserves its
    // "decide now" entry — dated today, where a calendar will surface it.
    expect(remindOnDate("2026-07-15", 7, "monthly", FROM)).toBe("2026-07-12");
  });
  it("uses the period's cap, not the requested lead", () => {
    expect(remindOnDate("2026-07-30", 30, "weekly", FROM)).toBe("2026-07-25");
  });
  it("has nothing to say about a renewal already past, or a missing date", () => {
    expect(remindOnDate("2026-07-01", 7, "monthly", FROM)).toBeNull();
    expect(remindOnDate("", 7, "monthly", FROM)).toBeNull();
    expect(remindOnDate("not-a-date", 7, "monthly", FROM)).toBeNull();
  });
});

describe("wantsRenewalNudge", () => {
  const base = { status: "active", remind: 1, next_renewal_date: "2026-08-01" };
  it("is true only for an active, opted-in, dated row", () => {
    expect(wantsRenewalNudge(base)).toBe(true);
    expect(wantsRenewalNudge({ ...base, remind: 0 })).toBe(false);
    expect(wantsRenewalNudge({ ...base, status: "cancelled" })).toBe(false);
    expect(wantsRenewalNudge({ ...base, next_renewal_date: "" })).toBe(false);
  });
});

describe("nudgeRetractionReason", () => {
  const on = { status: "active", remind: 1, next_renewal_date: "2026-08-01" };

  it("names the reason a nudged row stopped being nudged", () => {
    expect(nudgeRetractionReason(on, { ...on, remind: 0 })).toBe("reminder_off");
    expect(nudgeRetractionReason(on, { ...on, status: "cancelled" })).toBe("cancelled");
    expect(nudgeRetractionReason(on, { ...on, next_renewal_date: "" })).toBe("cancelled");
  });

  it("prefers the status when an edit both cancels and clears the reminder", () => {
    expect(nudgeRetractionReason(on, { ...on, status: "cancelled", remind: 0 })).toBe("cancelled");
  });

  it("is null while the row still wants a nudge", () => {
    expect(nudgeRetractionReason(on, { ...on, next_renewal_date: "2026-09-01" })).toBeNull();
    expect(nudgeRetractionReason(on, on)).toBeNull();
  });

  it("is null when there was never an entry to retract", () => {
    // The transition is what publishes, not the end state. A row that never
    // announced anything would otherwise spend an automation run on every save
    // to update zero calendar rows — and rules are rate-limited per day.
    const off = { ...on, remind: 0 };
    expect(nudgeRetractionReason(off, { ...off, status: "cancelled" })).toBeNull();
    expect(nudgeRetractionReason(null, off)).toBeNull();
  });

  it("is null when turning a nudge back ON", () => {
    // That path re-announces instead, which revives the same calendar entry.
    expect(nudgeRetractionReason({ ...on, remind: 0 }, on)).toBeNull();
  });
});

describe("nudge copy", () => {
  const sub = { name: "Streamly", amount_cents: 1549, billing_period: "monthly", next_renewal_date: "2026-08-29" };
  it("formats a plain calendar date without shifting timezone", () => {
    expect(shortDate("2026-08-29")).toBe("Aug 29");
    expect(shortDate("2026-01-01")).toBe("Jan 1");
    expect(shortDate("")).toBe("");
  });
  it("titles the calendar entry as the decision it is asking for", () => {
    expect(reviewTitle(sub)).toBe("Keep or cancel: Streamly (renews Aug 29)");
  });
  it("summarizes cost and date", () => {
    expect(reviewSummary(sub, (c) => `$${(c / 100).toFixed(2)}`)).toBe("$15.49 monthly · renews Aug 29");
  });
  it("describes a booked renewal for a ledger line", () => {
    expect(renewalDescription(sub)).toBe("Streamly (monthly subscription)");
  });
});

describe("searchableFields", () => {
  it("matches on category and notes, not just the service name", () => {
    const fields = searchableFields({
      name: "Streamly", category: "streaming", notes: "shared with Ada, cancel by June",
      url: "https://streamly.example",
    });
    expect(fields).toContain("streaming");
    expect(fields).toContain("shared with Ada, cancel by June");
  });
});
