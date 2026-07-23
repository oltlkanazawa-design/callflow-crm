// CallFlow Companion の設定読み込み。
// 環境変数のみを入力とし、既定値は開発者の意図しない公開を避ける安全側に倒す。
// Phase 2Bより、既定モードはHTTPS（TLS必須・HTTPへの自動フォールバックなし）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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

export type ExtraOriginsResult = { ok: true; origins: string[] } | { ok: false; reason: string };

/**
 * CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINS環境変数（カンマ区切り）を検証・解析する。
 * Vercel PreviewなどからローカルCompanionへ安全に接続確認するための、追加の許可Origin。
 * 1件でも不正な値が含まれる場合は黙って無視せず、呼び出し側で起動を拒否できるようエラーを返す。
 * 値そのものはエラーメッセージ・ログに含めない。
 */
export function parseExtraAllowedOrigins(raw: string | undefined): ExtraOriginsResult {
  if (raw === undefined || raw.trim() === "") return { ok: true, origins: [] };

  const parts = raw.split(",").map((part) => part.trim());
  const origins: string[] = [];

  for (const part of parts) {
    if (part === "") {
      return { ok: false, reason: "CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINSに空の項目が含まれています。" };
    }
    if (part.includes("*")) {
      return { ok: false, reason: "CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINSにワイルドカードは使用できません。" };
    }

    let parsed: URL;
    try {
      parsed = new URL(part);
    } catch {
      return { ok: false, reason: "CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINSに不正なURLが含まれています。" };
    }

    if (parsed.protocol !== "https:") {
      return { ok: false, reason: "CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINSはhttpsのURLのみ許可されます。" };
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return { ok: false, reason: "CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINSにユーザー名・パスワードを含めることはできません。" };
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      return { ok: false, reason: "CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINSにquery・fragmentを含めることはできません。" };
    }
    if (parsed.pathname !== "" && parsed.pathname !== "/") {
      return { ok: false, reason: "CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINSのパスは空または\"/\"のみ許可されます。" };
    }

    const canonical = parsed.origin;
    if (canonical === "null") {
      return { ok: false, reason: "CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINSに不正な値が含まれています。" };
    }
    if (!origins.includes(canonical)) origins.push(canonical);
  }

  return { ok: true, origins };
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * 許可Originの一覧を組み立てる。
 * secureでない場合（開発用の安全でないHTTPモード）は、CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINSを
 * 一切参照しない＝開発モードの許可範囲を広げない。secureな既定モードでのみ、検証済みの
 * 追加Originをproduction Originの後ろへ（重複除去のうえ）追記する。
 * 不正な値が1件でも含まれる場合は、黙って無視せず起動そのものを拒否する（呼び出し元へthrowする）。
 */
function resolveAllowedOrigins(secure: boolean): string[] {
  const base = secure ? [...DEV_ORIGINS, PRODUCTION_ORIGIN] : [...DEV_ORIGINS];
  if (!secure) return base;

  const extra = parseExtraAllowedOrigins(process.env.CALLFLOW_COMPANION_EXTRA_ALLOWED_ORIGINS);
  if (!extra.ok) {
    throw new Error(extra.reason);
  }

  const merged = [...base];
  for (const origin of extra.origins) {
    if (!merged.includes(origin)) merged.push(origin);
  }
  return merged;
}

export function defaultTmpDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "CallFlow Companion", "tmp");
}

function certificatesDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "CallFlow Companion", "certificates");
}

export function defaultCertPath(): string {
  return path.join(certificatesDir(), "companion-cert.pem");
}

export function defaultKeyPath(): string {
  return path.join(certificatesDir(), "companion-key.pem");
}

/**
 * 設定を読み込む。テストからは環境変数ではなく overrides を直接渡すことを想定する。
 *
 * secureは「意図した起動モード」を表す（allowInsecureHttpが明示されていない限りHTTPSが既定）。
 * 実際にその証明書・秘密鍵で起動できるかどうかはcanStartServer()が別途検証する
 * （存在しない・読み取れない・不正な証明書の場合はHTTPへ自動フォールバックせず起動を拒否する）。
 */
export function loadConfig(overrides: Partial<CompanionConfig> = {}): CompanionConfig {
  const allowInsecureHttp =
    overrides.allowInsecureHttp ?? process.env.CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP === "true";

  const tlsCertPath =
    overrides.tlsCertPath ?? process.env.CALLFLOW_COMPANION_TLS_CERT_PATH ?? defaultCertPath();
  const tlsKeyPath =
    overrides.tlsKeyPath ?? process.env.CALLFLOW_COMPANION_TLS_KEY_PATH ?? defaultKeyPath();

  // 明示的にoverrides.secureが指定されていればそれを尊重する（テスト用）。
  // それ以外は「安全でないHTTPモードが明示されていない限りHTTPSを既定とする」。
  const secure = overrides.secure ?? !allowInsecureHttp;

  const allowedOrigins = overrides.allowedOrigins ?? resolveAllowedOrigins(secure);

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

function readableFile(filePath: string): { ok: true; contents: Buffer } | { ok: false; reason: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, reason: "ファイルが存在しません" };
  }
  if (!stat.isFile()) {
    return { ok: false, reason: "通常のファイルではありません" };
  }
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch {
    return { ok: false, reason: "読み取り権限がありません" };
  }
  try {
    return { ok: true, contents: fs.readFileSync(filePath) };
  } catch {
    return { ok: false, reason: "読み込みに失敗しました" };
  }
}

/**
 * 起動可否を判定する。
 * - allowInsecureHttp（開発用）: 証明書は不要。
 * - HTTPS（既定）: 証明書・秘密鍵が存在し、読み取り可能で、有効な証明書として解釈できることを要求する。
 *   いずれかを満たさない場合はHTTPへ自動フォールバックせず起動を拒否する。
 */
export function canStartServer(config: CompanionConfig): { ok: true } | { ok: false; reason: string } {
  if (config.allowInsecureHttp) {
    return { ok: true };
  }

  if (!config.tlsCertPath || !config.tlsKeyPath) {
    return { ok: false, reason: "TLS証明書または秘密鍵のパスが設定されていません。" };
  }

  const cert = readableFile(config.tlsCertPath);
  if (!cert.ok) {
    return {
      ok: false,
      reason: `TLS証明書を読み込めません（${cert.reason}）。scripts/setup-callflow-companion-tls.sh を実行してください。`,
    };
  }

  const key = readableFile(config.tlsKeyPath);
  if (!key.ok) {
    return {
      ok: false,
      reason: `TLS秘密鍵を読み込めません（${key.reason}）。scripts/setup-callflow-companion-tls.sh を実行してください。`,
    };
  }

  try {
    new crypto.X509Certificate(cert.contents);
  } catch {
    return {
      ok: false,
      reason: "TLS証明書が不正です（有効な証明書として解釈できません）。scripts/setup-callflow-companion-tls.sh を再実行してください。",
    };
  }

  return { ok: true };
}
