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
 * 現在の実行ユーザーのUIDを返す。process.getuidが存在しない環境（Windows等）では
 * nullを返し、呼び出し側は所有者チェックだけを安全にスキップする。
 */
function currentUidIfAvailable(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function hasExactMode(mode: number, expected: number): boolean {
  return (mode & 0o777) === expected;
}

/**
 * 保存先ディレクトリが「symlinkではない通常のディレクトリ・（可能なら）現在の実行ユーザーが
 * 所有・権限がちょうど0700」であることを検証する。1つでも満たさない場合はfalseを返す
 * （例外は投げない＝呼び出し側は安全に「読み込み不可」として扱える）。
 */
async function isSecureDir(dirPath: string): Promise<boolean> {
  let stat;
  try {
    stat = await fsp.lstat(dirPath);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  const uid = currentUidIfAvailable();
  if (uid !== null && stat.uid !== uid) return false;
  if (!hasExactMode(stat.mode, DIR_MODE)) return false;
  return true;
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
 * ファイルが存在しない・JSONとして壊れている・スキーマが不正・symlinkである・
 * ディレクトリ/ファイルの所有者や権限が想定と異なる等、いずれの異常でも例外を投げず
 * 空配列を返す（＝安全に未ペアリング状態として扱われる）。トークンの値そのものは
 * ログへ一切出力しない。
 *
 * 保存先ディレクトリが通常のディレクトリ・非symlink・（可能なら）現在の実行ユーザー所有・
 * 権限0700であることをまず確認する。次にファイルをO_NOFOLLOWで開くことで、symlinkかどうかの
 * 確認とその後の読み込みを1回のopen呼び出しにまとめる（別々にlstat→readFileする場合に
 * 生じ得る、チェックと読み込みの間のすり替えを防ぐため）。以後のisFile・所有者・権限の
 * 確認・読み込みは、開いた後のfile handle自体に対して行うため、パスがその後どう変わっても
 * 影響を受けない。process.getuidが存在しない環境では所有者チェックのみ安全にスキップする。
 */
export async function loadTokenStore(filePath: string): Promise<IssuedToken[]> {
  const dir = path.dirname(filePath);
  let handle: fsp.FileHandle | undefined;
  try {
    if (!(await isSecureDir(dir))) return [];

    // O_NONBLOCKも付与する。万一そのパスにFIFO（名前付きパイプ）が置かれていた場合でも、
    // openがwriter待ちでブロックしてCompanionの起動そのものが止まってしまうことを防ぐ
    // （通常ファイルに対してはO_NONBLOCKは無害で、読み込み挙動に一切影響しない）。
    handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return [];
    const uid = currentUidIfAvailable();
    if (uid !== null && stat.uid !== uid) return [];
    if (!hasExactMode(stat.mode, FILE_MODE)) return [];

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
