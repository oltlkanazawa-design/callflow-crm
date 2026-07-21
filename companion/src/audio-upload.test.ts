import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  isSupportedMimeType,
  extensionForMimeType,
  receiveAudioUpload,
} from "./audio-upload.ts";
import { createTempFile, isWithinTmpDir } from "./temp-files.ts";

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "callflow-companion-test-"));
  return dir;
}

function fakeRequest(chunks: (Buffer | Uint8Array)[], erroring = false): IncomingMessage {
  // pull-based（消費されて初めてgeneratorが進む）にすることで、
  // receiveAudioUpload内のawait（一時ファイル作成）とのタイミング競合を避ける。
  async function* generate() {
    for (const chunk of chunks) {
      yield chunk;
    }
    if (erroring) {
      throw new Error("simulated client disconnect");
    }
  }
  return Readable.from(generate()) as unknown as IncomingMessage;
}

test("normalizeMimeType/isSupportedMimeType: 許可されたMIME Typeを受理する", () => {
  assert.equal(isSupportedMimeType("audio/webm;codecs=opus"), true);
  assert.equal(isSupportedMimeType("audio/webm"), true);
  assert.equal(isSupportedMimeType("audio/mp4"), true);
  assert.equal(isSupportedMimeType("AUDIO/WEBM"), true, "大文字小文字は区別しない");
});

test("isSupportedMimeType: 許可されていないMIME Typeは拒否する", () => {
  assert.equal(isSupportedMimeType("text/plain"), false);
  assert.equal(isSupportedMimeType("application/json"), false);
  assert.equal(isSupportedMimeType("application/octet-stream"), false);
  assert.equal(isSupportedMimeType("video/mp4"), false);
  assert.equal(isSupportedMimeType(""), false);
  assert.equal(isSupportedMimeType(null), false);
  assert.equal(isSupportedMimeType(undefined), false);
});

test("extensionForMimeType: webm系はwebm、mp4系はmp4", () => {
  assert.equal(extensionForMimeType("audio/webm;codecs=opus"), "webm");
  assert.equal(extensionForMimeType("audio/webm"), "webm");
  assert.equal(extensionForMimeType("audio/mp4"), "mp4");
});

test("receiveAudioUpload: 正常な音声を受信できる", async () => {
  const tmpDir = await makeTmpDir();
  try {
    const req = fakeRequest([Buffer.from([1, 2, 3, 4, 5])]);
    const result = await receiveAudioUpload(req, {
      tmpDir,
      maxBodyBytes: 1000,
      contentType: "audio/webm;codecs=opus",
      contentLengthHeader: 5,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.sizeBytes, 5);
      assert.equal(result.mimeType, "audio/webm;codecs=opus");
      const content = await fs.readFile(result.filePath);
      assert.deepEqual([...content], [1, 2, 3, 4, 5]);
      const stat = await fs.stat(result.filePath);
      assert.equal(stat.mode & 0o777, 0o600, "一時ファイルの権限は0600である必要がある");
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("receiveAudioUpload: 不正なMIME Typeはボディを読まずに拒否する（一時ファイルを作らない）", async () => {
  const tmpDir = await makeTmpDir();
  try {
    const req = fakeRequest([Buffer.from([1, 2, 3])]);
    const result = await receiveAudioUpload(req, {
      tmpDir,
      maxBodyBytes: 1000,
      contentType: "application/octet-stream",
      contentLengthHeader: 3,
    });
    assert.deepEqual(result, { ok: false, reason: "unsupported_media_type" });
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0, "不正MIME時は一時ファイルを作成してはいけない");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("receiveAudioUpload: 空ファイルは拒否し、一時ファイルを残さない", async () => {
  const tmpDir = await makeTmpDir();
  try {
    const req = fakeRequest([]);
    const result = await receiveAudioUpload(req, {
      tmpDir,
      maxBodyBytes: 1000,
      contentType: "audio/webm",
      contentLengthHeader: 0,
    });
    assert.deepEqual(result, { ok: false, reason: "empty_audio" });
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("receiveAudioUpload: Content-Lengthが上限を超える場合はボディを読まずに拒否する", async () => {
  const tmpDir = await makeTmpDir();
  try {
    const req = fakeRequest([Buffer.from([1, 2, 3])]);
    const result = await receiveAudioUpload(req, {
      tmpDir,
      maxBodyBytes: 10,
      contentType: "audio/webm",
      contentLengthHeader: 1000,
    });
    assert.deepEqual(result, { ok: false, reason: "payload_too_large" });
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("receiveAudioUpload: Content-Lengthが偽装（過少申告）されていても実受信バイト数で上限超過を検知し、一時ファイルを残さない", async () => {
  const tmpDir = await makeTmpDir();
  try {
    const bigChunk = Buffer.alloc(50, 7);
    const req = fakeRequest([bigChunk]);
    const result = await receiveAudioUpload(req, {
      tmpDir,
      maxBodyBytes: 10, // 実際は50バイト送るが申告は5バイト
      contentType: "audio/webm",
      contentLengthHeader: 5,
    });
    assert.deepEqual(result, { ok: false, reason: "payload_too_large" });
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0, "上限超過後は一時ファイルを削除している必要がある");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("receiveAudioUpload: Content-Lengthヘッダーが無くても実受信バイト数で上限を強制する", async () => {
  const tmpDir = await makeTmpDir();
  try {
    const bigChunk = Buffer.alloc(100, 9);
    const req = fakeRequest([bigChunk]);
    const result = await receiveAudioUpload(req, {
      tmpDir,
      maxBodyBytes: 10,
      contentType: "audio/webm",
      contentLengthHeader: null,
    });
    assert.deepEqual(result, { ok: false, reason: "payload_too_large" });
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("receiveAudioUpload: クライアント切断（ストリームエラー）時は一時ファイルを残さない", async () => {
  const tmpDir = await makeTmpDir();
  try {
    const req = fakeRequest([Buffer.from([1, 2, 3])], true);
    const result = await receiveAudioUpload(req, {
      tmpDir,
      maxBodyBytes: 1000,
      contentType: "audio/webm",
      contentLengthHeader: null,
    });
    assert.equal(result.ok, false);
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("temp-files: パストラバーサルを防止する（tmpDir外を指すパスはisWithinTmpDirでfalse）", async () => {
  const tmpDir = await makeTmpDir();
  try {
    assert.equal(isWithinTmpDir(tmpDir, path.join(tmpDir, "..", "evil.txt")), false);
    assert.equal(isWithinTmpDir(tmpDir, "/etc/passwd"), false);
    assert.equal(isWithinTmpDir(tmpDir, path.join(tmpDir, "safe.webm")), true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("temp-files: createTempFileは常にtmpDir配下・UUIDベースのファイル名を使う", async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { filePath, recordingId } = await createTempFile(tmpDir, "webm");
    assert.equal(isWithinTmpDir(tmpDir, filePath), true);
    assert.match(recordingId, /^[0-9a-f-]{36}$/);
    assert.equal(path.dirname(filePath), tmpDir);
    const stat = await fs.stat(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("temp-files: 拡張子に不正な文字が混入しても安全な文字だけに正規化される", async () => {
  const tmpDir = await makeTmpDir();
  try {
    const { filePath } = await createTempFile(tmpDir, "../../evil");
    assert.equal(isWithinTmpDir(tmpDir, filePath), true);
    assert.equal(path.dirname(filePath), tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
