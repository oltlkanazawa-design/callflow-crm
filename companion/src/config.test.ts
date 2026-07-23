import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExtraAllowedOrigins, loadConfig } from "./config.ts";

const PREVIEW_ORIGIN = "https://callflow-crm-git-feature-preview-example.vercel.app";
const PRODUCTION_ORIGIN = "https://callflow-crm-blue.vercel.app";
const DEV_ORIGIN = "http://localhost:3002";

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("parseExtraAllowedOrigins: 未設定（undefined）なら空配列", () => {
  const result = parseExtraAllowedOrigins(undefined);
  assert.deepEqual(result, { ok: true, origins: [] });
});

test("parseExtraAllowedOrigins: 空文字列なら空配列", () => {
  const result = parseExtraAllowedOrigins("   ");
  assert.deepEqual(result, { ok: true, origins: [] });
});

test("parseExtraAllowedOrigins: 正しいhttps Originを1件追加できる", () => {
  const result = parseExtraAllowedOrigins(PREVIEW_ORIGIN);
  assert.deepEqual(result, { ok: true, origins: [PREVIEW_ORIGIN] });
});

test("parseExtraAllowedOrigins: 複数Originをカンマ区切りで追加でき、前後の空白は無視する", () => {
  const other = "https://another-preview.example.vercel.app";
  const result = parseExtraAllowedOrigins(` ${PREVIEW_ORIGIN} , ${other} `);
  assert.deepEqual(result, { ok: true, origins: [PREVIEW_ORIGIN, other] });
});

test("parseExtraAllowedOrigins: 同一Originの重複は除去する", () => {
  const result = parseExtraAllowedOrigins(`${PREVIEW_ORIGIN},${PREVIEW_ORIGIN}`);
  assert.deepEqual(result, { ok: true, origins: [PREVIEW_ORIGIN] });
});

test("parseExtraAllowedOrigins: パスが空の場合は末尾スラッシュを含む形へ正規化されても1件として扱う", () => {
  const result = parseExtraAllowedOrigins("https://preview.example.vercel.app/");
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.origins, ["https://preview.example.vercel.app"]);
});

test("parseExtraAllowedOrigins: httpは拒否する", () => {
  const result = parseExtraAllowedOrigins("http://preview.example.vercel.app");
  assert.equal(result.ok, false);
});

test("parseExtraAllowedOrigins: ワイルドカード（単独）を拒否する", () => {
  const result = parseExtraAllowedOrigins("*");
  assert.equal(result.ok, false);
});

test("parseExtraAllowedOrigins: ワイルドカード（サブドメイン埋め込み）を拒否する", () => {
  const result = parseExtraAllowedOrigins("https://*.vercel.app");
  assert.equal(result.ok, false);
});

test("parseExtraAllowedOrigins: ユーザー名・パスワード付きURLを拒否する", () => {
  const result = parseExtraAllowedOrigins("https://user:pass@preview.example.vercel.app");
  assert.equal(result.ok, false);
});

test("parseExtraAllowedOrigins: queryを含むURLを拒否する", () => {
  const result = parseExtraAllowedOrigins("https://preview.example.vercel.app?token=abc");
  assert.equal(result.ok, false);
});

test("parseExtraAllowedOrigins: fragmentを含むURLを拒否する", () => {
  const result = parseExtraAllowedOrigins("https://preview.example.vercel.app#section");
  assert.equal(result.ok, false);
});

test("parseExtraAllowedOrigins: パス付き（/以外）のURLを拒否する", () => {
  const result = parseExtraAllowedOrigins("https://preview.example.vercel.app/dashboard");
  assert.equal(result.ok, false);
});

test("parseExtraAllowedOrigins: URLとして解釈できない値を拒否する", () => {
  const result = parseExtraAllowedOrigins("not-a-url");
  assert.equal(result.ok, false);
});

test("parseExtraAllowedOrigins: カンマの前後が空になる項目（空文字）を拒否する", () => {
  const result = parseExtraAllowedOrigins(`${PREVIEW_ORIGIN},,https://another.example.vercel.app`);
  assert.equal(result.ok, false);
});

test("parseExtraAllowedOrigins: 1件でも不正な値があれば全体を拒否する（正しい値が混ざっていても通さない）", () => {
  const result = parseExtraAllowedOrigins(`${PREVIEW_ORIGIN},http://insecure.example.com`);
  assert.equal(result.ok, false);
});

test("loadConfig: 環境変数未設定なら既存のDEV_ORIGINS・PRODUCTION_ORIGINのみ（挙動が変わらない）", () => {
  withEnv("CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINS", undefined, () => {
    const config = loadConfig({ secure: true });
    assert.ok(config.allowedOrigins.includes(DEV_ORIGIN));
    assert.ok(config.allowedOrigins.includes(PRODUCTION_ORIGIN));
    assert.ok(!config.allowedOrigins.includes(PREVIEW_ORIGIN));
  });
});

test("loadConfig: secure=trueの場合、検証済みの追加Originがproduction Originの後ろへ追記される", () => {
  withEnv("CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINS", PREVIEW_ORIGIN, () => {
    const config = loadConfig({ secure: true });
    assert.ok(config.allowedOrigins.includes(DEV_ORIGIN));
    assert.ok(config.allowedOrigins.includes(PRODUCTION_ORIGIN));
    assert.ok(config.allowedOrigins.includes(PREVIEW_ORIGIN));
  });
});

test("loadConfig: secure=false（開発用HTTPモード）では環境変数を一切参照せず、開発モードの許可範囲を広げない", () => {
  withEnv("CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINS", PREVIEW_ORIGIN, () => {
    const config = loadConfig({ secure: false });
    assert.ok(!config.allowedOrigins.includes(PREVIEW_ORIGIN));
    assert.ok(!config.allowedOrigins.includes(PRODUCTION_ORIGIN));
  });
});

test("loadConfig: overrides.allowedOriginsが指定されている場合は環境変数を無視する", () => {
  withEnv("CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINS", PREVIEW_ORIGIN, () => {
    const config = loadConfig({ secure: true, allowedOrigins: [DEV_ORIGIN] });
    assert.deepEqual(config.allowedOrigins, [DEV_ORIGIN]);
  });
});

test("loadConfig: 不正な追加Originが設定されている場合、黙って無視せず起動を拒否する（例外を投げる）", () => {
  withEnv("CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINS", "http://insecure.example.com", () => {
    assert.throws(() => loadConfig({ secure: true }));
  });
});
