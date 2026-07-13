import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(__dirname, "../manifest.json"), "utf-8"));

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
});
