import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsvText, detectDelimiter, autoDetectMapping, buildRows, summarizeRows,
  decodeCsvFile, normalizePhone, urlDomain, normalizeName, toHalfWidthDigits,
} from "./csv-import.ts";
import type { Company } from "./types.ts";

const existing: Company[] = [
  { id: "e1", name: "株式会社北陸テック", industry: "IT", location: "石川県金沢市", phone: "076-123-4567", website_url: "https://example.com/hokuriku-tech", contact_name: "山本様", heat: "中", owner_name: "辻 保", memo: "" },
];

test("parseCsvText: 引用符・カンマ内包・改行を含むフィールドを正しく分割する", () => {
  const csv = '企業名,メモ\n"サンプル株式会社","カンマ,を含むメモ"\n"改行企業","改行を\n含むメモ"\n';
  const table = parseCsvText(csv, ",");
  assert.equal(table.length, 3);
  assert.equal(table[1][1], "カンマ,を含むメモ");
  assert.equal(table[2][1], "改行を\n含むメモ");
});

test("parseCsvText: クォートで囲まれていない値の中の生のダブルクォートは消えない", () => {
  const csv = '企業名\nダブルクォート""テスト""です\n';
  const table = parseCsvText(csv, ",");
  assert.equal(table[1][0], 'ダブルクォート""テスト""です');
});

test("parseCsvText: エスケープされたダブルクォート(\"\")は1個の\"に戻る", () => {
  const csv = '企業名\n"ダブルクォート""入り""企業"\n';
  const table = parseCsvText(csv, ",");
  assert.equal(table[1][0], 'ダブルクォート"入り"企業');
});

test("parseCsvText: 空行は無視される", () => {
  const csv = "企業名,電話番号\nA社,076-000-0001\n\n\nB社,076-000-0002\n";
  const table = parseCsvText(csv, ",");
  assert.equal(table.length, 3);
});

test("detectDelimiter: カンマが多ければカンマ、タブが多ければタブと判定する", () => {
  assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
});

test("autoDetectMapping: 日本語ヘッダーを正しく判定する", () => {
  const mapping = autoDetectMapping(["企業名", "電話番号", "公式URL", "所在地", "業種", "担当者名", "メールアドレス", "メモ", "リスト名"]);
  assert.deepEqual(mapping, { 0: "name", 1: "phone", 2: "website_url", 3: "location", 4: "industry", 5: "contact_name", 6: "email", 7: "memo", 8: "list_source" });
});

test("autoDetectMapping: 英語別名ヘッダー・列順違いも判定する", () => {
  const mapping = autoDetectMapping(["company_name", "tel", "website"]);
  assert.deepEqual(mapping, { 0: "name", 1: "phone", 2: "website_url" });
});

test("autoDetectMapping: 未知の列はマッピングされない", () => {
  const mapping = autoDetectMapping(["企業名", "謎の列"]);
  assert.equal(mapping[0], "name");
  assert.equal(mapping[1], "");
});

// --- fix/csv-header-mapping: name/website_url/locationの素の英語ヘッダーが
//     未認識だった不具合（企業名が未入力です50件、登録可能0件）の回帰テスト ---

test("autoDetectMapping: 'name'ヘッダーが企業名として認識される", () => {
  const mapping = autoDetectMapping(["name", "phone", "website_url", "location", "industry", "contact_name", "email", "memo", "list_source"]);
  assert.deepEqual(mapping, { 0: "name", 1: "phone", 2: "website_url", 3: "location", 4: "industry", 5: "contact_name", 6: "email", 7: "memo", 8: "list_source" });
});

test("autoDetectMapping: 'company_name'ヘッダーが企業名として認識される", () => {
  const mapping = autoDetectMapping(["company_name"]);
  assert.equal(mapping[0], "name");
});

test("autoDetectMapping: 'website_url'ヘッダーがURLとして認識される", () => {
  const mapping = autoDetectMapping(["website_url"]);
  assert.equal(mapping[0], "website_url");
});

test("autoDetectMapping: 'location'ヘッダーが所在地として認識される", () => {
  const mapping = autoDetectMapping(["location"]);
  assert.equal(mapping[0], "location");
});

test("autoDetectMapping: BOM付きの'name'ヘッダーを認識する", () => {
  const mapping = autoDetectMapping(["﻿name", "phone"]);
  assert.equal(mapping[0], "name");
  assert.equal(mapping[1], "phone");
});

test("autoDetectMapping: 前後の空白・大文字小文字を正規化して認識する", () => {
  const mapping = autoDetectMapping(["  Name  ", " WEBSITE_URL ", "Location"]);
  assert.equal(mapping[0], "name");
  assert.equal(mapping[1], "website_url");
  assert.equal(mapping[2], "location");
});

test("autoDetectMapping: ハイフンとアンダースコアの表記差を吸収する", () => {
  const mapping = autoDetectMapping(["company-name", "website-url", "phone_number", "campaign-name"]);
  assert.equal(mapping[0], "name");
  assert.equal(mapping[1], "website_url");
  assert.equal(mapping[2], "phone");
  assert.equal(mapping[3], "list_source");
});

test("再現テスト: 実際の不具合CSVヘッダー（name/phone/website_url/location/industry/contact_name/email/memo/list_source）を50行とも正しく登録可能と判定する", () => {
  const header = "企業名,電話番号,URL,所在地,業種,担当者名,メールアドレス,メモ,リスト名"; // 表示用（実ヘッダーは英語）
  const englishHeader = ["name", "phone", "website_url", "location", "industry", "contact_name", "email", "memo", "list_source"];
  const lines = [englishHeader.join(",")];
  for (let i = 0; i < 50; i++) {
    lines.push(`回帰テスト企業${i},076-${String(1000 + i).padStart(4, "0")}-0000,https://example${i}.com,石川県金沢市,IT,担当${i},user${i}@example.com,メモ${i},リスト`);
  }
  const csv = "﻿" + lines.join("\r\n") + "\r\n";
  const table = parseCsvText(csv, detectDelimiter(csv));
  const mapping = autoDetectMapping(table[0]);
  assert.deepEqual(mapping, { 0: "name", 1: "phone", 2: "website_url", 3: "location", 4: "industry", 5: "contact_name", 6: "email", 7: "memo", 8: "list_source" });
  const rows = buildRows(table.slice(1), mapping, []);
  const summary = summarizeRows(table[0], mapping, rows);
  assert.equal(summary.total, 50);
  assert.equal(summary.validCount, 50);
  assert.equal(summary.missingRequiredCount, 0);
  void header;
});

test("normalizePhone: ハイフン・全角数字を除去して比較用の数字列にする", () => {
  assert.equal(normalizePhone("076-123-4567"), "0761234567");
  assert.equal(normalizePhone("０７６－１２３－４５６７"), "0761234567");
  assert.equal(normalizePhone(""), "");
});

test("toHalfWidthDigits: 全角数字のみ半角化し、記号は保持する", () => {
  assert.equal(toHalfWidthDigits("０７６-１２３-４５６７"), "076-123-4567");
});

test("urlDomain: protocol/www/パス/末尾スラッシュを除いたドメインを返す", () => {
  assert.equal(urlDomain("https://www.example.com/path/"), "example.com");
  assert.equal(urlDomain("example.com"), "example.com");
  assert.equal(urlDomain(""), "");
});

test("normalizeName: 前後・内部の空白を除去し小文字化する", () => {
  assert.equal(normalizeName(" 株式会社 サンプル 商事 "), "株式会社サンプル商事");
});

test("buildRows: 企業名が無い行のみエラー、電話番号・URL・所在地が空でも登録可能", () => {
  const csv = "企業名,電話番号,URL,所在地\n企業名のみ,,,\n,076-000-0001,https://x.example.com,石川県\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, []);
  assert.equal(rows[0].errors.length, 0);
  assert.ok(rows[1].errors.includes("企業名が未入力です"));
});

test("buildRows: 不正なメールアドレス・URLは警告のみで登録は可能", () => {
  const csv = "企業名,メールアドレス,URL\nテスト企業,invalid-email,not a url\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, []);
  assert.equal(rows[0].errors.length, 0);
  assert.ok(rows[0].warnings.some(w => w.includes("メールアドレス")));
  assert.ok(rows[0].warnings.some(w => w.includes("URL")));
});

test("summarizeRows: 警告のみの行（企業名一致・不正メール・不正URL）も登録可能件数(validCount)に含まれる", () => {
  const csv = "企業名,所在地,メールアドレス,URL\n株式会社北陸テック,,invalid-email,not a url\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, existing);
  const summary = summarizeRows(table[0], mapping, rows);
  assert.equal(rows[0].errors.length, 0);
  assert.ok(rows[0].warnings.length >= 2); // 企業名一致・メール形式・URL形式のうち複数
  assert.equal(rows[0].duplicate, null);
  assert.equal(summary.validCount, 1);
  assert.equal(summary.duplicateCount, 0);
});

test("buildRows: エラー・重複がある行でも警告は保持される（画面はエラー→重複→警告の優先順位で1つだけ表示する設計）", () => {
  // 電話番号が既存企業と一致（重複）しつつ、メールアドレスの形式も不正なケース
  const csv = "企業名,電話番号,メールアドレス\n電話重複企業,076-123-4567,invalid-email\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, existing);
  assert.equal(rows[0].errors.length, 0);
  assert.equal(rows[0].duplicate?.tier, "phone");
  assert.ok(rows[0].warnings.some(w => w.includes("メールアドレス")));
  // 画面側は r.errors → r.duplicate → r.warnings → 登録可能 の順で最初に該当したものだけを表示する
});

test("buildRows: 電話番号一致でDB内重複を検出する", () => {
  const csv = "企業名,電話番号\n北陸テック別名,076-123-4567\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, existing);
  assert.equal(rows[0].duplicate?.tier, "phone");
  assert.equal(rows[0].duplicate?.matchedExisting?.id, "e1");
});

test("buildRows: URLドメイン一致でDB内重複を検出する", () => {
  const csv = "企業名,URL\n別名企業,https://example.com/hokuriku-tech-another-page\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, existing);
  assert.equal(rows[0].duplicate?.tier, "domain");
});

test("buildRows: 企業名+所在地一致でDB内重複を検出する（両方に所在地がある場合のみ）", () => {
  const csv = "企業名,所在地\n株式会社北陸テック,石川県金沢市\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, existing);
  assert.equal(rows[0].duplicate?.tier, "name_location");
});

test("buildRows: 所在地が片方でも空欄なら企業名一致だけでは重複扱いにせず、警告に留める", () => {
  const csv = "企業名,所在地\n株式会社北陸テック,\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, existing);
  assert.equal(rows[0].duplicate, null);
  assert.ok(rows[0].warnings.some(w => w.includes("企業名が一致する既存データ")));
});

test("buildRows: 既存企業側の所在地が空欄の場合も、企業名一致だけでは重複扱いにしない", () => {
  const noLocationExisting: Company[] = [
    { id: "e2", name: "所在地未登録企業", industry: "", location: "", phone: "", contact_name: "", heat: "低", owner_name: "辻 保", memo: "" },
  ];
  const csv = "企業名,所在地\n所在地未登録企業,石川県金沢市\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, noLocationExisting);
  assert.equal(rows[0].duplicate, null);
  assert.ok(rows[0].warnings.some(w => w.includes("企業名が一致する既存データ")));
});

test("buildRows: CSV内重複は1件目は重複なし、2件目以降がwithinCsvの重複として検出される", () => {
  const csv = "企業名,電話番号\n重複太郎,076-999-0000\n重複太郎,076-999-0000\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, []);
  assert.equal(rows[0].duplicate, null);
  assert.equal(rows[1].duplicate?.withinCsv, true);
  assert.equal(rows[1].duplicate?.matchedExisting, undefined);
});

test("summarizeRows: 総件数・登録可能・必須項目不足・重複候補を正しく集計する", () => {
  const csv = "企業名,電話番号\n正常企業,076-000-0001\n,076-000-0002\n北陸テック別名,076-123-4567\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, existing);
  const summary = summarizeRows(table[0], mapping, rows);
  assert.equal(summary.total, 3);
  assert.equal(summary.missingRequiredCount, 1);
  assert.equal(summary.validCount, 2);
  assert.equal(summary.duplicateCount, 1);
});

test("decodeCsvFile: UTF-8(BOM付き)とShift-JISの両方を正しくデコードできる", async () => {
  const utf8Bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("企業名,電話番号\n")]);
  const utf8File = new File([utf8Bom], "a.csv", { type: "text/csv" });
  const decodedUtf8 = await decodeCsvFile(utf8File as unknown as File);
  assert.equal(decodedUtf8, "企業名,電話番号\n");

  const sjisBytes = Buffer.from([0x8a, 0xe9, 0x8b, 0xc6, 0x96, 0xbc]); // "企業名" のShift-JISバイト列
  const sjisFile = new File([sjisBytes], "b.csv", { type: "text/csv" });
  const decodedSjis = await decodeCsvFile(sjisFile as unknown as File);
  assert.equal(decodedSjis, "企業名");
});

test("大量データ(1000件)でも件数・重複判定が正しく成立する", () => {
  const header = "企業名,電話番号\n";
  const lines: string[] = [];
  for (let i = 0; i < 1000; i++) lines.push(`件数テスト企業${i},076-${String(1000 + (i % 8000)).padStart(4, "0")}-${String(i).padStart(4, "0")}`);
  const csv = header + lines.join("\n") + "\n";
  const table = parseCsvText(csv, ",");
  const mapping = autoDetectMapping(table[0]);
  const rows = buildRows(table.slice(1), mapping, []);
  const summary = summarizeRows(table[0], mapping, rows);
  assert.equal(summary.total, 1000);
  assert.equal(summary.validCount, 1000);
  assert.equal(summary.duplicateCount, 0);
});

