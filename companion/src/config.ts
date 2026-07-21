// CallFlow Companion の設定読み込み。
// 環境変数のみを入力とし、既定値は開発者の意図しない公開を避ける安全側に倒す。

import os from "node:os";
import path from "node:path";
import type { CompanionConfig } from "./types.ts";

export const DEFAULT_PORT = 4318;
export const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024; // 100MB
export const DEFAULT_PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10分
export const DEFAULT_PAIRING_MAX_ATTEMPTS = 5;

export const PRODUCTION_ORIGIN = "https://callflow-crm-blue.vercel.app";

const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3002",
  "http://127.0.0.1:3002",
] as const;

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function defaultTmpDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "CallFlow Companion", "tmp");
}

/**
 * 設定を読み込む。テストからは環境変数ではなく overrides を直接渡すことを想定する。
 * allowInsecureHttp が false（既定）の場合、TLS証明書・秘密鍵のパスが両方揃っていなければ
 * 呼び出し側（server.ts）が起動を拒否する設計とする（このファイルでは検証のみ行い、例外は投げない）。
 */
export function loadConfig(overrides: Partial<CompanionConfig> = {}): CompanionConfig {
  const allowInsecureHttp =
    overrides.allowInsecureHttp ?? process.env.CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP === "true";

  const tlsCertPath = overrides.tlsCertPath ?? process.env.CALLFLOW_COMPANION_TLS_CERT ?? null;
  const tlsKeyPath = overrides.tlsKeyPath ?? process.env.CALLFLOW_COMPANION_TLS_KEY ?? null;
  const secure = overrides.secure ?? Boolean(tlsCertPath && tlsKeyPath);

  const allowedOrigins =
    overrides.allowedOrigins ?? (secure ? [...DEV_ORIGINS, PRODUCTION_ORIGIN] : [...DEV_ORIGINS]);

  return {
    host: "127.0.0.1",
    port: overrides.port ?? readIntEnv("CALLFLOW_COMPANION_PORT", DEFAULT_PORT),
    secure,
    allowInsecureHttp,
    tlsCertPath,
    tlsKeyPath,
    tmpDir: overrides.tmpDir ?? process.env.CALLFLOW_COMPANION_TMP_DIR ?? defaultTmpDir(),
    allowedOrigins,
    maxBodyBytes:
      overrides.maxBodyBytes ?? readIntEnv("CALLFLOW_COMPANION_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES),
    pairingCodeTtlMs:
      overrides.pairingCodeTtlMs ??
      readIntEnv("CALLFLOW_COMPANION_PAIRING_TTL_MS", DEFAULT_PAIRING_CODE_TTL_MS),
    pairingMaxAttempts:
      overrides.pairingMaxAttempts ??
      readIntEnv("CALLFLOW_COMPANION_PAIRING_MAX_ATTEMPTS", DEFAULT_PAIRING_MAX_ATTEMPTS),
    tokenLockoutOnLimit: overrides.tokenLockoutOnLimit ?? true,
  };
}

/**
 * 起動可否を判定する。HTTPSに必要な設定が揃っておらず、かつ
 * 明示的な安全でないHTTPモードも許可されていない場合は起動を拒否する。
 */
export function canStartServer(config: CompanionConfig): { ok: true } | { ok: false; reason: string } {
  if (config.secure) {
    if (!config.tlsCertPath || !config.tlsKeyPath) {
      return { ok: false, reason: "secureがtrueですがTLS証明書または秘密鍵のパスが設定されていません。" };
    }
    return { ok: true };
  }
  if (!config.allowInsecureHttp) {
    return {
      ok: false,
      reason:
        "TLS証明書・秘密鍵が設定されていません。開発用の安全でないHTTPモードで起動するには " +
        "CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP=true を明示的に設定してください。",
    };
  }
  return { ok: true };
}
