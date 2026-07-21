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

  constructor(config: Pick<CompanionConfig, "pairingCodeTtlMs" | "pairingMaxAttempts">, now: number = Date.now()) {
    this.config = config;
    this.session = createPairingSession(now, config.pairingCodeTtlMs);
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

  get issuedTokenCount(): number {
    return this.tokens.size;
  }
}
