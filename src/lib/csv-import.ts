import type { Company, Heat } from "./types";

export type CanonicalField = "name" | "phone" | "website_url" | "location" | "industry" | "contact_name" | "email" | "memo" | "list_source";
export type ColumnMapping = Record<number, CanonicalField | "">;
export type DuplicateTier = "phone" | "domain" | "name_location";
export type DuplicateMode = "skip" | "update" | "insert";

export const CANONICAL_FIELD_ORDER: CanonicalField[] = ["name", "phone", "website_url", "location", "industry", "contact_name", "email", "memo", "list_source"];
export const CANONICAL_FIELD_LABELS: Record<CanonicalField, string> = {
  name: "企業名", phone: "電話番号", website_url: "公式URL", location: "所在地",
  industry: "業種", contact_name: "担当者名", email: "メールアドレス", memo: "メモ", list_source: "リスト名／キャンペーン名",
};
export const DUPLICATE_TIER_LABELS: Record<DuplicateTier, string> = {
  phone: "電話番号が一致", domain: "公式URLのドメインが一致", name_location: "企業名・所在地が一致",
};

const HEADER_ALIASES: Record<CanonicalField, string[]> = {
  name: ["企業名", "会社名", "法人名", "company", "companyname", "company_name"],
  phone: ["電話番号", "電話", "tel", "phone"],
  website_url: ["url", "公式url", "公式サイト", "webサイト", "ウェブサイト", "website"],
  location: ["所在地", "住所", "address"],
  industry: ["業種", "industry"],
  contact_name: ["担当者", "担当者名", "contact", "contactname", "contact_name"],
  email: ["メール", "メールアドレス", "email"],
  memo: ["メモ", "備考", "memo", "note", "notes"],
  list_source: ["リスト名", "キャンペーン名", "list", "campaign", "list_source"],
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_HOST_PATTERN = /^([\w-]+\.)+[\w-]{2,}(\/.*)?$/i;

export interface CsvRowResult {
  rowIndex: number;
  raw: string[];
  name: string;
  phone: string;
  website_url: string;
  location: string;
  industry: string;
  contact_name: string;
  email: string;
  memo: string;
  list_source: string;
  errors: string[];
  warnings: string[];
  duplicate: { tier: DuplicateTier; matchedExisting?: Company; withinCsv: boolean } | null;
}

export interface ImportSummary {
  total: number;
  validCount: number;
  missingRequiredCount: number;
  duplicateCount: number;
  headers: string[];
  mapping: ColumnMapping;
  previewRows: CsvRowResult[];
}

/** UTF-8として厳密デコードを試み、失敗（不正なバイト列）ならShift-JISとして読み直す */
export async function decodeCsvFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift-jis", { fatal: false }).decode(bytes).replace(/^﻿/, "");
  }
}

export function detectDelimiter(text: string): "," | "\t" {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const commas = (firstLine.match(/,/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  return tabs > commas ? "\t" : ",";
}

/** RFC4180準拠の最小限CSVパーサー。引用符で囲まれたカンマ・改行・エスケープ済み引用符に対応 */
export function parseCsvText(text: string, delimiter: "," | "\t" = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false; // フィールド先頭の文字をまだ受け取っていないか（先頭の"のみをクォート開始として扱うため）
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const endField = () => { row.push(field); field = ""; fieldStarted = false; };
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !fieldStarted) { inQuotes = true; fieldStarted = true; continue; }
    if (ch === delimiter) { endField(); continue; }
    if (ch === "\n") { endField(); rows.push(row); row = []; continue; }
    field += ch; fieldStarted = true;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ""));
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s　]+/g, "");
}

export function autoDetectMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<CanonicalField>();
  headers.forEach((h, idx) => {
    const norm = normalizeHeader(h);
    let found: CanonicalField | "" = "";
    for (const key of CANONICAL_FIELD_ORDER) {
      if (used.has(key)) continue;
      if (HEADER_ALIASES[key].some(alias => normalizeHeader(alias) === norm)) { found = key; break; }
    }
    if (found) used.add(found);
    mapping[idx] = found;
  });
  return mapping;
}

// 全角数字・全角ハイフン（Excel等で全角統一されたCSVで見られる）を半角に変換する。他の記号はそのまま残す
export function toHalfWidthDigits(raw: string): string {
  return (raw || "")
    .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[－ー―]/g, "-");
}

export function normalizePhone(raw: string): string {
  return toHalfWidthDigits(raw).replace(/\D/g, "");
}

export function urlDomain(raw: string): string {
  if (!raw) return "";
  let v = raw.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "");
  v = v.replace(/^www\./, "");
  v = v.split(/[/?#]/)[0];
  return v;
}

export function normalizeName(raw: string): string {
  return (raw || "").trim().replace(/\s+/g, "").toLowerCase();
}

function normalizeUrlValue(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

interface RegistryEntry { existing?: Company }
interface Registry {
  phone: Map<string, RegistryEntry>;
  domain: Map<string, RegistryEntry>;
  nameLocation: Map<string, RegistryEntry>;
  nameOnly: Map<string, RegistryEntry>;
}

function seedRegistry(existing: Company[]): Registry {
  const registry: Registry = { phone: new Map(), domain: new Map(), nameLocation: new Map(), nameOnly: new Map() };
  for (const c of existing) {
    const phoneKey = normalizePhone(c.phone);
    if (phoneKey && !registry.phone.has(phoneKey)) registry.phone.set(phoneKey, { existing: c });
    const domainKey = urlDomain(c.website_url || "");
    if (domainKey && !registry.domain.has(domainKey)) registry.domain.set(domainKey, { existing: c });
    const nameKey = normalizeName(c.name);
    if (nameKey) {
      // 所在地が双方とも入力されている場合のみ「企業名+所在地」一致を重複候補として扱う
      const locKey = normalizeName(c.location);
      if (locKey) {
        const nameLocKey = `${nameKey}|${locKey}`;
        if (!registry.nameLocation.has(nameLocKey)) registry.nameLocation.set(nameLocKey, { existing: c });
      }
      if (!registry.nameOnly.has(nameKey)) registry.nameOnly.set(nameKey, { existing: c });
    }
  }
  return registry;
}

/** ヘッダー行・データ行・列マッピング・既存企業一覧から、行ごとの検証結果と重複候補を組み立てる */
export function buildRows(dataRows: string[][], mapping: ColumnMapping, existing: Company[]): CsvRowResult[] {
  const registry = seedRegistry(existing);
  const columnFor = (field: CanonicalField): number | undefined => {
    const entry = Object.entries(mapping).find(([, v]) => v === field);
    return entry ? Number(entry[0]) : undefined;
  };
  const columns: Record<CanonicalField, number | undefined> = CANONICAL_FIELD_ORDER.reduce(
    (acc, field) => ({ ...acc, [field]: columnFor(field) }), {} as Record<CanonicalField, number | undefined>,
  );
  const get = (raw: string[], field: CanonicalField): string => {
    const idx = columns[field];
    return idx !== undefined ? (raw[idx] || "").trim() : "";
  };

  return dataRows.map((raw, rowIndex) => {
    const name = get(raw, "name");
    const phone = get(raw, "phone");
    const website_url = get(raw, "website_url");
    const location = get(raw, "location");
    const industry = get(raw, "industry");
    const contact_name = get(raw, "contact_name");
    const email = get(raw, "email");
    const memo = get(raw, "memo");
    const list_source = get(raw, "list_source");

    const errors: string[] = [];
    const warnings: string[] = [];
    if (!name) errors.push("企業名が未入力です");
    if (email && !EMAIL_PATTERN.test(email)) warnings.push("メールアドレスの形式が正しくない可能性があります");
    if (website_url && !URL_HOST_PATTERN.test(website_url.replace(/^https?:\/\//i, ""))) warnings.push("URLの形式が正しくない可能性があります");

    let duplicate: CsvRowResult["duplicate"] = null;
    if (name) {
      const phoneKey = normalizePhone(phone);
      const domainKey = urlDomain(website_url);
      const nameKey = normalizeName(name);
      const locKey = normalizeName(location);
      // 所在地が双方とも入力されている場合のみ「企業名+所在地」一致を重複候補として扱う
      const nameLocKey = locKey ? `${nameKey}|${locKey}` : "";
      if (phoneKey && registry.phone.has(phoneKey)) {
        const hit = registry.phone.get(phoneKey)!;
        duplicate = { tier: "phone", matchedExisting: hit.existing, withinCsv: !hit.existing };
      } else if (domainKey && registry.domain.has(domainKey)) {
        const hit = registry.domain.get(domainKey)!;
        duplicate = { tier: "domain", matchedExisting: hit.existing, withinCsv: !hit.existing };
      } else if (nameLocKey && registry.nameLocation.has(nameLocKey)) {
        const hit = registry.nameLocation.get(nameLocKey)!;
        duplicate = { tier: "name_location", matchedExisting: hit.existing, withinCsv: !hit.existing };
      }

      // 企業名だけが一致し重複候補とはみなさない場合は、警告として伝える
      if (!duplicate && registry.nameOnly.has(nameKey)) {
        warnings.push("企業名が一致する既存データがあります（所在地が異なる、または未入力のため重複登録とはみなしていません）");
      }

      if (phoneKey && !registry.phone.has(phoneKey)) registry.phone.set(phoneKey, {});
      if (domainKey && !registry.domain.has(domainKey)) registry.domain.set(domainKey, {});
      if (nameLocKey && !registry.nameLocation.has(nameLocKey)) registry.nameLocation.set(nameLocKey, {});
      if (!registry.nameOnly.has(nameKey)) registry.nameOnly.set(nameKey, {});
    }

    return { rowIndex, raw, name, phone, website_url, location, industry, contact_name, email, memo, list_source, errors, warnings, duplicate };
  });
}

export function summarizeRows(headers: string[], mapping: ColumnMapping, rows: CsvRowResult[], previewCount = 10): ImportSummary {
  const missingRequiredCount = rows.filter(r => r.errors.length > 0).length;
  const validCount = rows.length - missingRequiredCount;
  const duplicateCount = rows.filter(r => !r.errors.length && r.duplicate).length;
  return { total: rows.length, validCount, missingRequiredCount, duplicateCount, headers, mapping, previewRows: rows.slice(0, previewCount) };
}

export function rowToCompanyDraft(row: CsvRowResult, owner: string, defaultListSource: string): Company {
  return {
    id: crypto.randomUUID(),
    name: row.name,
    industry: row.industry,
    location: row.location,
    phone: toHalfWidthDigits(row.phone),
    website_url: row.website_url ? normalizeUrlValue(row.website_url) : undefined,
    email: row.email || undefined,
    list_source: row.list_source || defaultListSource || "CSV一括登録",
    contact_name: row.contact_name,
    contact_department: "",
    heat: "低" as Heat,
    owner_name: owner,
    memo: row.memo || "CSV一括登録で取り込み",
  };
}

function escapeCsvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildErrorReportCsv(rows: CsvRowResult[]): string {
  const errorRows = rows.filter(r => r.errors.length > 0);
  const lines = [
    ["行番号", "企業名", "電話番号", "エラー理由"],
    ...errorRows.map(r => [String(r.rowIndex + 2), r.name || "(空欄)", r.phone, r.errors.join(" / ")]),
  ];
  return lines.map(cols => cols.map(escapeCsvField).join(",")).join("\r\n");
}
