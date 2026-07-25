// pairing-store.ts（永続化されたペアリングトークンハッシュのatomic読み書き）の単体テスト。

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadTokenStore, saveTokenStore } from "./pairing-store.ts";
import type { IssuedToken } from "./types.ts";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "callflow-pairing-store-test-"));
}

function sampleHash(): string {
  return crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex");
}

test("saveTokenStore → loadTokenStore: 保存した内容がそのまま読み込める", async () => {
  const dir = await makeTmpDir();
  try {
    const storePath = path.join(dir, "sub", "pairing-tokens.json");
    const tokens: IssuedToken[] = [
      { tokenHash: sampleHash(), issuedAt: 1000 },
      { tokenHash: sampleHash(), issuedAt: 2000 },
    ];
    await saveTokenStore(storePath, tokens);
    const loaded = await loadTokenStore(storePath);
    assert.deepEqual(loaded, tokens);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saveTokenStore: 生のBearerトークンに相当する値は一切書き込まれない（ハッシュとissuedAtのみ）", async () => {
  const dir = await makeTmpDir();
  try {
    const storePath = path.join(dir, "pairing-tokens.json");
    await saveTokenStore(storePath, [{ tokenHash: sampleHash(), issuedAt: 1000 }]);
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed).sort(), ["tokens", "version"]);
    for (const entry of parsed.tokens) {
      assert.deepEqual(Object.keys(entry).sort(), ["issuedAt", "tokenHash"]);
      // tokenHashはSHA-256のhex（64文字）でなければならない＝base64urlの生トークン（32バイト→43文字前後）ではない
      assert.match(entry.tokenHash, /^[0-9a-f]{64}$/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saveTokenStore: ディレクトリ・ファイルの権限がそれぞれ0700・0600になる", async () => {
  const dir = await makeTmpDir();
  try {
    const subDir = path.join(dir, "sub");
    const storePath = path.join(subDir, "pairing-tokens.json");
    await saveTokenStore(storePath, [{ tokenHash: sampleHash(), issuedAt: 1000 }]);

    const dirStat = await fs.stat(subDir);
    const fileStat = await fs.stat(storePath);
    assert.equal(dirStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saveTokenStore: 保存後、ディレクトリに一時ファイルが残らない（atomic rename）", async () => {
  const dir = await makeTmpDir();
  try {
    const storePath = path.join(dir, "pairing-tokens.json");
    await saveTokenStore(storePath, [{ tokenHash: sampleHash(), issuedAt: 1000 }]);
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, ["pairing-tokens.json"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadTokenStore: ファイルが存在しない場合は空配列（クラッシュしない）", async () => {
  const dir = await makeTmpDir();
  try {
    const loaded = await loadTokenStore(path.join(dir, "does-not-exist.json"));
    assert.deepEqual(loaded, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadTokenStore: 壊れたJSONの場合は空配列へ安全にフォールバックする", async () => {
  const dir = await makeTmpDir();
  try {
    const storePath = path.join(dir, "pairing-tokens.json");
    await fs.writeFile(storePath, "{ this is not valid json", "utf8");
    const loaded = await loadTokenStore(storePath);
    assert.deepEqual(loaded, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadTokenStore: バージョン不一致・スキーマ不正の場合は空配列へフォールバックする", async () => {
  const dir = await makeTmpDir();
  try {
    const storePath = path.join(dir, "pairing-tokens.json");
    await fs.writeFile(storePath, JSON.stringify({ version: 999, tokens: [{ tokenHash: "x", issuedAt: 1 }] }), "utf8");
    assert.deepEqual(await loadTokenStore(storePath), []);

    await fs.writeFile(storePath, JSON.stringify({ version: 1, tokens: [{ tokenHash: "not-a-hex-hash", issuedAt: 1 }] }), "utf8");
    assert.deepEqual(await loadTokenStore(storePath), []);

    await fs.writeFile(storePath, JSON.stringify({ version: 1, tokens: "not-an-array" }), "utf8");
    assert.deepEqual(await loadTokenStore(storePath), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadTokenStore: 保存先パスがsymlinkの場合は辿らず空配列を返す", async () => {
  const dir = await makeTmpDir();
  try {
    const realFile = path.join(dir, "real-secret.json");
    await fs.writeFile(realFile, JSON.stringify({ version: 1, tokens: [{ tokenHash: sampleHash(), issuedAt: 1 }] }), "utf8");
    const linkPath = path.join(dir, "pairing-tokens.json");
    await fs.symlink(realFile, linkPath);

    const loaded = await loadTokenStore(linkPath);
    assert.deepEqual(loaded, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saveTokenStore: 保存先パスが既存のsymlinkでも、リンク先ではなくリンク自体が安全に置き換わる", async () => {
  const dir = await makeTmpDir();
  try {
    const realFile = path.join(dir, "attacker-target.json");
    await fs.writeFile(realFile, "original-untouched-content", "utf8");
    const linkPath = path.join(dir, "pairing-tokens.json");
    await fs.symlink(realFile, linkPath);

    const tokens: IssuedToken[] = [{ tokenHash: sampleHash(), issuedAt: 42 }];
    await saveTokenStore(linkPath, tokens);

    // symlinkのリンク先には一切書き込まれていない
    const targetContent = await fs.readFile(realFile, "utf8");
    assert.equal(targetContent, "original-untouched-content");

    // linkPath自体は通常ファイルに置き換わり、正しい内容が読める
    const linkStat = await fs.lstat(linkPath);
    assert.equal(linkStat.isSymbolicLink(), false);
    const loaded = await loadTokenStore(linkPath);
    assert.deepEqual(loaded, tokens);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ensureSecureDir相当: 保存先ディレクトリがsymlinkの場合でも安全に作り直して保存できる", async () => {
  const dir = await makeTmpDir();
  try {
    const realDir = path.join(dir, "attacker-dir");
    await fs.mkdir(realDir);
    await fs.writeFile(path.join(realDir, "unrelated.txt"), "should-not-be-touched", "utf8");
    const linkDir = path.join(dir, "sub");
    await fs.symlink(realDir, linkDir);

    const storePath = path.join(linkDir, "pairing-tokens.json");
    const tokens: IssuedToken[] = [{ tokenHash: sampleHash(), issuedAt: 7 }];
    await saveTokenStore(storePath, tokens);

    // symlinkの先の既存ディレクトリには一切書き込まれていない
    const realDirEntries = await fs.readdir(realDir);
    assert.deepEqual(realDirEntries, ["unrelated.txt"]);

    // linkDir自体は通常ディレクトリに置き換わり、正しく保存・読み込みできる
    const linkStat = await fs.lstat(linkDir);
    assert.equal(linkStat.isSymbolicLink(), false);
    assert.deepEqual(await loadTokenStore(storePath), tokens);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ===========================================================
// ディレクトリ・ファイルの所有者・権限検証（loadTokenStore）
// ===========================================================

test("loadTokenStore: ファイルの権限が0644の場合は読み込まず空配列を返す", async () => {
  const dir = await makeTmpDir();
  try {
    const storePath = path.join(dir, "pairing-tokens.json");
    const tokens: IssuedToken[] = [{ tokenHash: sampleHash(), issuedAt: 1 }];
    await saveTokenStore(storePath, tokens);
    await fs.chmod(storePath, 0o644);
    assert.deepEqual(await loadTokenStore(storePath), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadTokenStore: ファイルの権限が0666の場合は読み込まず空配列を返す", async () => {
  const dir = await makeTmpDir();
  try {
    const storePath = path.join(dir, "pairing-tokens.json");
    const tokens: IssuedToken[] = [{ tokenHash: sampleHash(), issuedAt: 1 }];
    await saveTokenStore(storePath, tokens);
    await fs.chmod(storePath, 0o666);
    assert.deepEqual(await loadTokenStore(storePath), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadTokenStore: 保存先ディレクトリの権限が0755の場合は読み込まず空配列を返す", async () => {
  const dir = await makeTmpDir();
  try {
    const subDir = path.join(dir, "sub");
    const storePath = path.join(subDir, "pairing-tokens.json");
    const tokens: IssuedToken[] = [{ tokenHash: sampleHash(), issuedAt: 1 }];
    await saveTokenStore(storePath, tokens);
    await fs.chmod(subDir, 0o755);
    assert.deepEqual(await loadTokenStore(storePath), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("loadTokenStore: ディレクトリ0700・ファイル0600の正常な状態は復元に成功する", async () => {
  const dir = await makeTmpDir();
  try {
    const subDir = path.join(dir, "sub");
    const storePath = path.join(subDir, "pairing-tokens.json");
    const tokens: IssuedToken[] = [{ tokenHash: sampleHash(), issuedAt: 123 }];
    await saveTokenStore(storePath, tokens);

    const dirStat = await fs.stat(subDir);
    const fileStat = await fs.stat(storePath);
    assert.equal(dirStat.mode & 0o777, 0o700);
    assert.equal(fileStat.mode & 0o777, 0o600);

    assert.deepEqual(await loadTokenStore(storePath), tokens);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("saveTokenStore → loadTokenStore: 空配列も正しく往復する（全失効後の状態）", async () => {
  const dir = await makeTmpDir();
  try {
    const storePath = path.join(dir, "pairing-tokens.json");
    await saveTokenStore(storePath, [{ tokenHash: sampleHash(), issuedAt: 1 }]);
    await saveTokenStore(storePath, []);
    assert.deepEqual(await loadTokenStore(storePath), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
