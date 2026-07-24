// ペアリング済みトークンのハッシュを、リポジトリ外のファイルへ永続化する。
// 生のBearerトークンは一切書き込まない（SHA-256ハッシュのみ）。
// 破損・不正な権限・symlinkなど、あらゆる異常時は例外を投げず安全に空の状態へフォールバックする
// （Companionの起動そのものをクラッシュさせない）。

import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { IssuedToken } from "./types.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const STORE_VERSION = 1;
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/; // SHA-256 (hex)

interface TokenStoreFile {
  version: number;
  tokens: IssuedToken[];
}

function isValidStoredToken(value: unknown): value is IssuedToken {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.tokenHash === "string" && TOKEN_HASH_RE.test(v.tokenHash) && typeof v.issuedAt === "number" && Number.isFinite(v.issuedAt);
}

function isValidStoreFile(value: unknown): value is TokenStoreFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === STORE_VERSION && Array.isArray(v.tokens) && v.tokens.every(isValidStoredToken);
}

/**
 * ディレクトリを安全に確保する。symlinkや通常ディレクトリでない何かが既に存在する場合は
 * 削除して作り直す（destinationがsymlinkだと後続の書き込みが意図しない場所へ及ぶ恐れがあるため）。
 * 既存ディレクトリの権限が緩い場合に備えて、最後に必ず0700へ締め直す。
 */
async function ensureSecureDir(dirPath: string): Promise<void> {
  try {
    const stat = await fsp.lstat(dirPath);
    if (stat.isSymbolicLink()) {
      await fsp.unlink(dirPath);
      await fsp.mkdir(dirPath, { recursive: true, mode: DIR_MODE });
    } else if (!stat.isDirectory()) {
      await fsp.rm(dirPath, { force: true });
      await fsp.mkdir(dirPath, { recursive: true, mode: DIR_MODE });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fsp.mkdir(dirPath, { recursive: true, mode: DIR_MODE });
  }
  await fsp.chmod(dirPath, DIR_MODE);
}

/**
 * 保存済みトークンハッシュを読み込む。
 * ファイルが存在しない・JSONとして壊れている・スキーマが不正・symlinkである等、
 * いずれの異常でも例外を投げず空配列を返す（＝安全に未ペアリング状態として扱われる）。
 * トークンの値そのものはログへ一切出力しない。
 *
 * O_NOFOLLOWで開くことで、symlinkかどうかの確認とその後の読み込みを1回のopen呼び出しに
 * まとめている（別々にlstat→readFileする場合に生じ得る、チェックと読み込みの間の
 * すり替えを防ぐため）。以後のisFile確認・読み込みは、開いた後のfile handle自体に対して
 * 行うため、パスがその後どう変わっても影響を受けない。
 */
export async function loadTokenStore(filePath: string): Promise<IssuedToken[]> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) return [];
    const raw = await handle.readFile("utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isValidStoreFile(parsed)) return [];
    return parsed.tokens;
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

/**
 * 保存済みトークンハッシュをatomicに書き込む。
 * 同一ディレクトリ内に排他作成（'wx'）した一時ファイルへ書き込んでからfs.renameで
 * 最終パスへ置き換える。rename()はdestinationのディレクトリエントリ自体を置き換えるだけで
 * symlinkのリンク先を辿らないため、destinationへのsymlink-swap攻撃に対しても安全。
 */
export async function saveTokenStore(filePath: string, tokens: readonly IssuedToken[]): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureSecureDir(dir);

  const payload: TokenStoreFile = { version: STORE_VERSION, tokens: [...tokens] };
  const tmpPath = path.join(dir, `.pairing-tokens.${crypto.randomUUID()}.tmp`);

  const handle = await fsp.open(tmpPath, "wx", FILE_MODE);
  try {
    await handle.writeFile(JSON.stringify(payload), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.chmod(tmpPath, FILE_MODE);
  await fsp.rename(tmpPath, filePath);
}
