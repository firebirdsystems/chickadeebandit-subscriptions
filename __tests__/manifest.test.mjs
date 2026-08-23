import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";
import { PERIODS } from "../src/logic.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));
const migration003 = readFileSync(join(__dirname, "../migrations/003_renewal_reminders.sql"), "utf-8");
const indexHtml = readFileSync(join(__dirname, "../src/index.html"), "utf-8");

describe("manifest.json", () => {
  it("has required string fields", () => {
    for (const field of ["id", "name", "version", "description", "entrypoint", "runtime", "icon"]) {
      expect(manifest[field], `missing field: ${field}`).toBeTruthy();
    }
  });
  it("entrypoint/runtime/storage are standard", () => {
    expect(manifest.entrypoint).toBe("index.html");
    expect(manifest.runtime).toBe("static");
    expect(manifest.storage).toBe("db");
  });
  it("version follows semver", () => expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/));
  it("has a nav label", () => expect(manifest.nav?.label).toBeTruthy());

  it("subscriptions table is adult_writable", () => {
    expect(manifest.row_policies?.subscriptions?.kind).toBe("adult_writable");
  });

  it("SQL-filtered columns are declared plaintext", () => {
    expect(manifest.db_plaintext_columns).toContain("billing_period");
    expect(manifest.db_plaintext_columns).toContain("next_renewal_date");
  });

  it("ai exports match the query files", () => {
    expect(manifest.ai_access?.db_exports).toEqual(["active_subscriptions"]);
  });

  describe("renewal reminders", () => {
    const dr = manifest.date_reminders;

    it("anchors on the plaintext renewal date, one-shot (not annual)", () => {
      // A renewal is a moving one-shot date rolled forward by "mark renewed",
      // never a fixed month/day — declaring both anchors is rejected by the hub.
      expect(dr.date_column).toBe("next_renewal_date");
      expect(dr.month_column).toBeUndefined();
      expect(manifest.db_plaintext_columns).toContain("next_renewal_date");
    });

    it("declares the capabilities the protocol actually consumes", () => {
      expect(manifest.required_capabilities).toEqual(expect.arrayContaining(["cron", "email"]));
    });

    it("every column the hub compares on is plaintext", () => {
      // The hub compares these itself, and an encrypted value can't be
      // compared. A column is plaintext if it is on the codec's built-in skip
      // list (`category`, and any `_at`/`_date`/`_id` suffix) or declared here.
      const builtIn = new Set(["status", "type", "category", "visibility", "audience"]);
      const isPlaintext = (col) =>
        builtIn.has(col) || /_(at|date|id|by)$/.test(col) || manifest.db_plaintext_columns.includes(col);
      for (const col of [dr.date_column, dr.enabled_column, dr.visibility_column, dr.kind_column, dr.last_reminded_column]) {
        expect(isPlaintext(col), `${col} must be plaintext`).toBe(true);
      }
    });

    it("emails the payer by default and falls back to adults, never to silence", () => {
      // remind_scope defaults to 'payer' (migration 003), which is NOT in
      // everyone_values — so a row reaches its payer alone unless widened.
      expect(dr.visibility_column).toBe("remind_scope");
      expect(dr.everyone_values).toEqual(["household"]);
      expect(dr.owner_column).toBe("payer_id");
      // payer_id is '' when nobody is recorded, so the payer audience can be
      // empty; without this the bill would go unmentioned.
      expect(dr.on_no_recipients).toBe("adults");
    });

    it("defaults lead_days to a value every billing period can honor", () => {
      // The column DEFAULT is a constant, so it has to hold for the shortest
      // period — an INSERT that omits it (the add_subscription automation
      // action) must not land a weekly row on a lead time that would silence
      // it forever. See maxLeadDays() in logic.js.
      const m = /ADD COLUMN lead_days INTEGER NOT NULL DEFAULT (\d+)/.exec(migration003);
      expect(m).not.toBeNull();
      expect(Number(m[1])).toBeLessThanOrEqual(Math.min(...PERIODS.map((p) => p.maxLead)));
    });

    it("backfills cancelled subscriptions to remind = 0", () => {
      // date_reminders has no status filter: it reads `remind` alone. A
      // cancelled row left at remind = 1 would be emailed about a renewal that
      // will never happen.
      expect(migration003).toMatch(/remind\s*=\s*CASE WHEN status = 'cancelled' THEN 0 ELSE 1 END/);
    });

    it("shares one lead time with the calendar nudge", () => {
      expect(dr.lead_days_column).toBe("lead_days");
      // The hub applies this fallback with no clamp and no idea of the billing
      // period, so it must be a lead time EVERY period can honor — 7 would
      // silence a weekly row forever (see maxLeadDays / migration 003).
      expect(dr.default_lead_days).toBe(5);
      expect(dr.default_lead_days).toBeLessThanOrEqual(
        Math.min(...PERIODS.map((p) => p.maxLead)),
      );
    });
  });

  describe("renewal automations", () => {
    it("publishes every renewal event, adults only", () => {
      for (const type of [
        "subscription.renewal_upcoming",
        "subscription.renewal_cancelled",
        "subscription.renewed",
      ]) {
        expect(manifest.publishes).toContain(type);
        // Both drive trusted writes in another app (a calendar entry, a
        // transaction), so a child must not be able to POST a fabricated one.
        expect(manifest.publish_acls[type]).toEqual({ require_role: "adult" });
      }
    });

    it("suggests rules whose params exist on the event that triggers them", () => {
      const payloads = {
        "subscription.renewal_upcoming": ["review_title", "remind_on", "summary", "source_ref_id"],
        "subscription.renewal_cancelled": ["source_ref_id", "name", "reason"],
        "subscription.renewed": ["amount_cents", "description", "paid_on"],
      };
      for (const s of manifest.suggested_automations) {
        for (const source of Object.values(s.param_map)) {
          expect(source.kind).toBe("payload_field");
          expect(payloads[s.trigger_event]).toContain(source.value);
        }
      }
    });

    it("targets the calendar and the budget app", () => {
      expect(manifest.suggested_automations.map((s) => `${s.target_app_id}.${s.action_id}`))
        .toEqual([
          "calendar.upsert_dated_event",
          "calendar.retract_dated_event",
          "finances.record_transaction",
        ]);
    });

    it("ships the retraction beside the announcement, on the same reference", () => {
      // The pair is the feature. An announcement rule without its retraction
      // leaves a cancelled subscription's entry on the calendar forever, which
      // is the exact failure this event was added for — and the two must agree
      // on source_ref_id or the retraction scopes to nothing.
      const [announce, retract] = manifest.suggested_automations;
      expect(announce.trigger_event).toBe("subscription.renewal_upcoming");
      expect(retract.trigger_event).toBe("subscription.renewal_cancelled");
      expect(retract.param_map.source_ref_id).toEqual(announce.param_map.source_ref_id);
      // Only the reference is mapped: a retraction that carried a date or a
      // title would be claiming to know something it is not scoped by.
      expect(Object.keys(retract.param_map)).toEqual(["source_ref_id"]);
    });

    it("gives the calendar a stable reference so an edit moves one entry", () => {
      // The calendar upserts on source_ref_id. Without it in the param_map the
      // action is skipped outright (an unmapped :param is an unresolved param,
      // not a null); with a non-constant one, every edit would land a second
      // entry beside the stale first.
      const cal = manifest.suggested_automations.find((s) => s.target_app_id === "calendar");
      expect(cal.action_id).toBe("upsert_dated_event");
      expect(cal.param_map.source_ref_id).toEqual({ kind: "payload_field", value: "source_ref_id" });
      // Namespaced by app: the key shares one column with every publisher.
      expect(indexHtml).toContain("source_ref_id: `subscriptions:${sub.id}`");
    });
  });
});
