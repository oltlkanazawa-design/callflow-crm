import { test } from "node:test";
import assert from "node:assert/strict";
import { isCompanyArchived, filterCompaniesByArchiveState } from "./company-archive.ts";
import type { Company } from "./types.ts";

const baseCompany = (overrides: Partial<Company>): Company => ({
  id: "c1", name: "テスト企業", industry: "", location: "", phone: "",
  contact_name: "", heat: "低", owner_name: "未割当", memo: "",
  ...overrides,
});

test("isCompanyArchived: archived_atが設定されていればtrue", () => {
  assert.equal(isCompanyArchived(baseCompany({ archived_at: "2026-07-25T00:00:00Z" })), true);
});

test("isCompanyArchived: archived_atがnull/undefinedならfalse", () => {
  assert.equal(isCompanyArchived(baseCompany({ archived_at: null })), false);
  assert.equal(isCompanyArchived(baseCompany({ archived_at: undefined })), false);
  assert.equal(isCompanyArchived(baseCompany({})), false);
});

test("filterCompaniesByArchiveState: showArchived=falseなら有効な企業だけを返す", () => {
  const companies = [
    baseCompany({ id: "active-1", archived_at: null }),
    baseCompany({ id: "archived-1", archived_at: "2026-07-25T00:00:00Z" }),
    baseCompany({ id: "active-2" }),
  ];
  const result = filterCompaniesByArchiveState(companies, false);
  assert.deepEqual(result.map(c => c.id), ["active-1", "active-2"]);
});

test("filterCompaniesByArchiveState: showArchived=trueならアーカイブ済みの企業だけを返す", () => {
  const companies = [
    baseCompany({ id: "active-1", archived_at: null }),
    baseCompany({ id: "archived-1", archived_at: "2026-07-25T00:00:00Z" }),
    baseCompany({ id: "archived-2", archived_at: "2026-07-20T00:00:00Z" }),
  ];
  const result = filterCompaniesByArchiveState(companies, true);
  assert.deepEqual(result.map(c => c.id), ["archived-1", "archived-2"]);
});
