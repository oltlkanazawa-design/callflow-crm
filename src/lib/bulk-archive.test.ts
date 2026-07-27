import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeCompanyIds, buildBulkArchivePreview, bulkArchiveResultMessage, MAX_BULK_ARCHIVE_IDS } from "./bulk-archive.ts";

test("dedupeCompanyIds: 重複IDを1件へ整理する", () => {
  assert.deepEqual(dedupeCompanyIds(["a", "b", "a", "a", "c"]).sort(), ["a", "b", "c"]);
});

test("dedupeCompanyIds: null/undefined要素を取り除く", () => {
  assert.deepEqual(dedupeCompanyIds(["a", null, undefined, "b"]).sort(), ["a", "b"]);
});

test("dedupeCompanyIds: 空配列・null/undefinedのみなら空配列を返す", () => {
  assert.deepEqual(dedupeCompanyIds([]), []);
  assert.deepEqual(dedupeCompanyIds([null, undefined]), []);
});

test("MAX_BULK_ARCHIVE_IDS: サーバー側と同じ上限（500）", () => {
  assert.equal(MAX_BULK_ARCHIVE_IDS, 500);
});

test("buildBulkArchivePreview: 5件以下ならすべて表示しmoreCountは0", () => {
  const companies = [{ name: "A社" }, { name: "B社" }, { name: "C社" }];
  const preview = buildBulkArchivePreview(companies);
  assert.deepEqual(preview.shownNames, ["A社", "B社", "C社"]);
  assert.equal(preview.moreCount, 0);
});

test("buildBulkArchivePreview: 6件以上なら先頭5件＋残り件数を返す", () => {
  const companies = Array.from({ length: 8 }, (_, i) => ({ name: `企業${i + 1}` }));
  const preview = buildBulkArchivePreview(companies);
  assert.deepEqual(preview.shownNames, ["企業1", "企業2", "企業3", "企業4", "企業5"]);
  assert.equal(preview.moreCount, 3);
});

test("buildBulkArchivePreview: ちょうど5件ならmoreCountは0", () => {
  const companies = Array.from({ length: 5 }, (_, i) => ({ name: `企業${i + 1}` }));
  const preview = buildBulkArchivePreview(companies);
  assert.equal(preview.shownNames.length, 5);
  assert.equal(preview.moreCount, 0);
});

test("buildBulkArchivePreview: 0件なら空配列とmoreCount 0", () => {
  const preview = buildBulkArchivePreview([]);
  assert.deepEqual(preview.shownNames, []);
  assert.equal(preview.moreCount, 0);
});

test("bulkArchiveResultMessage: 既アーカイブ済みが0件なら内訳を出さない", () => {
  assert.equal(bulkArchiveResultMessage({ archived_count: 8, already_archived_count: 0 }), "8件の企業をアーカイブしました");
});

test("bulkArchiveResultMessage: 既アーカイブ済みが混在していれば内訳を出す", () => {
  assert.equal(
    bulkArchiveResultMessage({ archived_count: 8, already_archived_count: 2 }),
    "8件をアーカイブしました（2件は既にアーカイブ済みでした）",
  );
});

test("bulkArchiveResultMessage: 全件が既アーカイブ済みでも内訳を出す", () => {
  assert.equal(
    bulkArchiveResultMessage({ archived_count: 0, already_archived_count: 3 }),
    "0件をアーカイブしました（3件は既にアーカイブ済みでした）",
  );
});
