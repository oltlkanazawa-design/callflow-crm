import { test } from "node:test";
import assert from "node:assert/strict";
import { PairingManager, createPairingSession } from "./pairing.ts";

const BASE_CONFIG = { pairingCodeTtlMs: 10 * 60 * 1000, pairingMaxAttempts: 5 };

test("createPairingSession: 6桁の数字コードを生成する", () => {
  const session = createPairingSession(1000, 60_000);
  assert.match(session.code, /^\d{6}$/);
  assert.equal(session.used, false);
  assert.equal(session.failedAttempts, 0);
  assert.equal(session.expiresAt, 1000 + 60_000);
});

test("attemptPair: 正しいコードでトークンが発行される", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  const result = manager.attemptPair(manager.currentCode, 1000);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(typeof result.token, "string");
    assert.ok(result.token.length >= 32, "トークンは十分な長さが必要");
  }
});

test("attemptPair: 間違ったコードは invalid_code になる", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  const wrong = manager.currentCode === "000000" ? "111111" : "000000";
  const result = manager.attemptPair(wrong, 1000);
  assert.deepEqual(result, { ok: false, reason: "invalid_code" });
});

test("attemptPair: 期限切れコードは expired_code になる", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  const result = manager.attemptPair(manager.currentCode, 1000 + BASE_CONFIG.pairingCodeTtlMs + 1);
  assert.deepEqual(result, { ok: false, reason: "expired_code" });
});

test("attemptPair: 使用済みコードは code_already_used になる", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  const code = manager.currentCode;
  const first = manager.attemptPair(code, 1000);
  assert.equal(first.ok, true);
  const second = manager.attemptPair(code, 1001);
  assert.deepEqual(second, { ok: false, reason: "code_already_used" });
});

test("attemptPair: 不正な形式（6桁数字以外）は invalid_request になる", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  assert.deepEqual(manager.attemptPair("abc123", 1000), { ok: false, reason: "invalid_request" });
  assert.deepEqual(manager.attemptPair("12345", 1000), { ok: false, reason: "invalid_request" });
  assert.deepEqual(manager.attemptPair("", 1000), { ok: false, reason: "invalid_request" });
});

test("attemptPair: 連続失敗回数の上限を超えると too_many_attempts になる（正しいコードでも拒否）", () => {
  const manager = new PairingManager({ pairingCodeTtlMs: 60_000, pairingMaxAttempts: 3 }, 1000);
  const code = manager.currentCode;
  const wrong = code === "000000" ? "111111" : "000000";
  manager.attemptPair(wrong, 1000);
  manager.attemptPair(wrong, 1001);
  manager.attemptPair(wrong, 1002);
  const result = manager.attemptPair(code, 1003);
  assert.deepEqual(result, { ok: false, reason: "too_many_attempts" });
});

test("verifyToken: 発行された正しいBearerトークンは検証を通る", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  const result = manager.attemptPair(manager.currentCode, 1000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(manager.verifyToken(`Bearer ${result.token}`), true);
});

test("verifyToken: 無効なトークンは拒否される", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  manager.attemptPair(manager.currentCode, 1000);
  assert.equal(manager.verifyToken("Bearer not-a-real-token"), false);
});

test("verifyToken: Authorizationヘッダーが無い場合は拒否される", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  manager.attemptPair(manager.currentCode, 1000);
  assert.equal(manager.verifyToken(undefined), false);
});

test("verifyToken: Bearerプレフィックスが無い場合は拒否される", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  const result = manager.attemptPair(manager.currentCode, 1000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(manager.verifyToken(result.token), false);
});

test("regenerate: 新しいコードを再発行するとトークンは維持されつつコードが変わる", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  const oldCode = manager.currentCode;
  const result = manager.attemptPair(oldCode, 1000);
  assert.equal(result.ok, true);
  manager.regenerate(2000);
  assert.notEqual(manager.currentCode, oldCode);
  if (result.ok) {
    assert.equal(manager.verifyToken(`Bearer ${result.token}`), true);
  }
});
