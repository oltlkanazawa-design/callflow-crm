import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { PairingManager, createPairingSession } from "./pairing.ts";

const BASE_CONFIG = { pairingCodeTtlMs: 10 * 60 * 1000, pairingMaxAttempts: 5 };

function hashTokenForTest(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

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

// ===========================================================
// 永続化されたトークンのハイドレーション・失効（信頼済み端末方式）
// ===========================================================

test("コンストラクタ: persistedTokensから復元したハッシュに一致するトークンはverifyTokenを通る（Companion再起動の相当試験）", () => {
  const rawToken = "restored-raw-token-from-previous-session";
  const persisted = [{ tokenHash: hashTokenForTest(rawToken), issuedAt: 500 }];
  // 「新しいPairingManagerインスタンス」＝Companionプロセス再起動を模擬する。
  // attemptPairを一度も呼ばずにverifyTokenが通ることが、再ペアリング不要であることの証明になる。
  const manager = new PairingManager(BASE_CONFIG, 1000, persisted);
  assert.equal(manager.verifyToken(`Bearer ${rawToken}`), true);
  assert.equal(manager.issuedTokenCount, 1);
});

test("コンストラクタ: persistedTokensに無いトークンは引き続き拒否される", () => {
  const persisted = [{ tokenHash: hashTokenForTest("some-other-token"), issuedAt: 500 }];
  const manager = new PairingManager(BASE_CONFIG, 1000, persisted);
  assert.equal(manager.verifyToken("Bearer unknown-token"), false);
});

test("listStoredTokens: attemptPair成功後、永続化用のハッシュ一覧に反映される（生トークンは含まれない）", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  const result = manager.attemptPair(manager.currentCode, 1000);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const stored = manager.listStoredTokens();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].tokenHash, hashTokenForTest(result.token));
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(result.token));
});

test("revokeCurrentToken: 現在のトークンを失効させると、以後verifyTokenは拒否する", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  const result = manager.attemptPair(manager.currentCode, 1000);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(manager.verifyToken(`Bearer ${result.token}`), true);
  const revoked = manager.revokeCurrentToken(`Bearer ${result.token}`);
  assert.equal(revoked, true);
  assert.equal(manager.verifyToken(`Bearer ${result.token}`), false);
  assert.equal(manager.issuedTokenCount, 0);
});

test("revokeCurrentToken: 既に無効なトークン・不正なヘッダーはfalseを返し何も変化しない", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000);
  const result = manager.attemptPair(manager.currentCode, 1000);
  assert.equal(result.ok, true);
  assert.equal(manager.revokeCurrentToken("Bearer not-a-real-token"), false);
  assert.equal(manager.revokeCurrentToken(undefined), false);
  assert.equal(manager.issuedTokenCount, 1);
});

test("revokeAllTokens: 複数端末分のトークンを一括で失効させ、以後すべて拒否される", () => {
  const manager = new PairingManager(BASE_CONFIG, 1000, [
    { tokenHash: hashTokenForTest("device-a"), issuedAt: 1 },
    { tokenHash: hashTokenForTest("device-b"), issuedAt: 2 },
  ]);
  assert.equal(manager.verifyToken("Bearer device-a"), true);
  assert.equal(manager.verifyToken("Bearer device-b"), true);

  const revokedCount = manager.revokeAllTokens();
  assert.equal(revokedCount, 2);
  assert.equal(manager.verifyToken("Bearer device-a"), false);
  assert.equal(manager.verifyToken("Bearer device-b"), false);
  assert.equal(manager.issuedTokenCount, 0);
});
