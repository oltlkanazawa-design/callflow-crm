// ペアリングコードの発行・検証と、Bearerトークンの発行・検証を担う。
// すべてメモリ上のみで管理し、プロセス再起動で必ず失効する。

import crypto from "node:crypto";
import type { CompanionConfig, IssuedToken, PairFailureReason, PairingSession } from "./types.ts";

const TOKEN_BYTES = 32; // 256bit

function generateSixDigitCode(): string {
  const n = crypto.randomInt(0, 1_000_000);
  return n.toString(10).padStart(6, "0");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createPairingSession(now: number = Date.now(), ttlMs: number): PairingSession {
  return {
    code: generateSixDigitCode(),
    createdAt: now,
    expiresAt: now + ttlMs,
    used: false,
    failedAttempts: 0,
    locked: false,
  };
}

export type PairAttemptResult = { ok: true; token: string } | { ok: false; reason: PairFailureReason };

export class PairingManager {
  private session: PairingSession;
  private readonly tokens = new Map<string, IssuedToken>();
  private readonly config: Pick<CompanionConfig, "pairingCodeTtlMs" | "pairingMaxAttempts">;

  /**
   * persistedTokensは、前回のCompanion起動時に永続化されたトークンハッシュ（生トークンは含まない）。
   * 起動時にここへ渡すことで、Companion再起動後もブラウザ側の既存トークンがそのまま使い続けられる。
   */
  constructor(
    config: Pick<CompanionConfig, "pairingCodeTtlMs" | "pairingMaxAttempts">,
    now: number = Date.now(),
    persistedTokens: readonly IssuedToken[] = [],
  ) {
    this.config = config;
    this.session = createPairingSession(now, config.pairingCodeTtlMs);
    for (const issued of persistedTokens) {
      this.tokens.set(issued.tokenHash, issued);
    }
  }

  get currentCode(): string {
    return this.session.code;
  }

  get currentExpiresAt(): number {
    return this.session.expiresAt;
  }

  /** テスト・運用上の理由でコードを再発行したい場合に使う（Phase 2Aでは起動時のみ呼ばれる想定）。 */
  regenerate(now: number = Date.now()): void {
    this.session = createPairingSession(now, this.config.pairingCodeTtlMs);
  }

  attemptPair(inputCode: string, now: number = Date.now()): PairAttemptResult {
    const session = this.session;

    if (typeof inputCode !== "string" || !/^\d{6}$/.test(inputCode)) {
      return { ok: false, reason: "invalid_request" };
    }
    if (session.used) {
      return { ok: false, reason: "code_already_used" };
    }
    if (now >= session.expiresAt) {
      return { ok: false, reason: "expired_code" };
    }
    if (session.locked || session.failedAttempts >= this.config.pairingMaxAttempts) {
      session.locked = true;
      return { ok: false, reason: "too_many_attempts" };
    }

    if (inputCode !== session.code) {
      session.failedAttempts += 1;
      if (session.failedAttempts >= this.config.pairingMaxAttempts) {
        session.locked = true;
      }
      return { ok: false, reason: "invalid_code" };
    }

    session.used = true;
    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    this.tokens.set(hashToken(token), { tokenHash: hashToken(token), issuedAt: now });
    return { ok: true, token };
  }

  verifyToken(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
      return false;
    }
    const token = authorizationHeader.slice("Bearer ".length).trim();
    if (!token) return false;
    const candidateHash = hashToken(token);
    for (const issued of this.tokens.values()) {
      if (timingSafeEqualHex(candidateHash, issued.tokenHash)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Authorizationヘッダーが指すトークン1件だけを失効させる（ブラウザ側の「ペアリングを解除」用）。
   * verifyTokenと同じタイミングセーフな比較で対象を探す。該当が見つかれば失効させtrueを返す。
   */
  revokeCurrentToken(authorizationHeader: string | undefined): boolean {
    if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
      return false;
    }
    const token = authorizationHeader.slice("Bearer ".length).trim();
    if (!token) return false;
    const candidateHash = hashToken(token);
    for (const key of this.tokens.keys()) {
      if (timingSafeEqualHex(candidateHash, key)) {
        this.tokens.delete(key);
        return true;
      }
    }
    return false;
  }

  /** すべての端末のトークンを一括で失効させる（「すべての端末とのペアリングを解除」用）。失効件数を返す。 */
  revokeAllTokens(): number {
    const count = this.tokens.size;
    this.tokens.clear();
    return count;
  }

  /** 永続化のため、現在有効なトークンハッシュ一覧を返す（生トークンは含まれない）。 */
  listStoredTokens(): IssuedToken[] {
    return [...this.tokens.values()];
  }

  get issuedTokenCount(): number {
    return this.tokens.size;
  }
}
