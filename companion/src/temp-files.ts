// 一時音声ファイルの安全な作成・削除・清掃を担う。
// ファイル名は必ずこちら側で crypto.randomUUID() を使って生成し、
// リクエストヘッダーの値（企業名・録音IDなど）を一切ファイル名に使用しない。

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export async function ensureTmpDir(tmpDir: string): Promise<void> {
  await fsp.mkdir(tmpDir, { recursive: true, mode: DIR_MODE });
  // 既存ディレクトリの権限が緩い場合に備えて明示的に締め直す。
  await fsp.chmod(tmpDir, DIR_MODE);
}

/** tmpDir配下に収まっているかを検証する（パストラバーサル対策）。 */
export function isWithinTmpDir(tmpDir: string, targetPath: string): boolean {
  const resolvedDir = path.resolve(tmpDir) + path.sep;
  const resolvedTarget = path.resolve(targetPath);
  return (resolvedTarget + path.sep).startsWith(resolvedDir) || resolvedTarget === path.resolve(tmpDir);
}

export interface TempFileHandle {
  filePath: string;
  recordingId: string;
}

/**
 * 新しい一時ファイルを排他的に作成する（'wx'フラグ）。
 * 既にファイル・シンボリックリンクが存在する場合は失敗する
 * （UUIDの衝突は現実的に起こらないが、既存パスへの書き込みを防ぐための防御）。
 */
export async function createTempFile(tmpDir: string, extension: string): Promise<TempFileHandle> {
  const recordingId = crypto.randomUUID();
  const safeExtension = extension.replace(/[^a-z0-9]/gi, "");
  const fileName = `${recordingId}.${safeExtension}`;
  const filePath = path.join(tmpDir, fileName);

  if (!isWithinTmpDir(tmpDir, filePath)) {
    throw new Error("生成された一時ファイルパスがtmpDirの外部を指しています");
  }

  const handle = await fsp.open(filePath, "wx", FILE_MODE);
  await handle.close();
  await fsp.chmod(filePath, FILE_MODE);

  return { filePath, recordingId };
}

/**
 * 一時ファイルを安全に削除する。シンボリックリンクの場合はリンク自体を消すのみで、
 * リンク先を辿って削除することはない。tmpDirの外を指すパスは拒否する。
 */
export async function deleteTempFile(tmpDir: string, filePath: string): Promise<boolean> {
  if (!isWithinTmpDir(tmpDir, filePath)) {
    return false;
  }
  try {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return false;
    }
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true; // 既に存在しない = 削除済みとみなす
    }
    return false;
  }
}

/** 起動時・終了時に、残存する一時ファイルをすべて削除する。 */
export async function cleanupAllTempFiles(tmpDir: string): Promise<{ removed: number; failed: number }> {
  let removed = 0;
  let failed = 0;
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(tmpDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { removed: 0, failed: 0 };
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(tmpDir, entry);
    const ok = await deleteTempFile(tmpDir, fullPath);
    if (ok) removed += 1;
    else failed += 1;
  }
  return { removed, failed };
}

export function createWriteStream(filePath: string): fs.WriteStream {
  return fs.createWriteStream(filePath, { mode: FILE_MODE, flags: "w" });
}
