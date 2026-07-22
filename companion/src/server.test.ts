import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { startServer, type StartedCompanion } from "./server.ts";
import type { CompanionConfig } from "./types.ts";

const ALLOWED_ORIGIN = "http://localhost:3002";
const PRODUCTION_ORIGIN = "https://callflow-crm-blue.vercel.app";
const DISALLOWED_ORIGIN = "https://evil.example.com";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "callflow-companion-server-test-"));
}

/**
 * テストだけで使う自己署名証明書を一時ディレクトリへ生成する。
 * 実際のmkcert CAROOT・秘密鍵は一切使用しない。openssl（システム標準）のみを使う。
 */
function generateTestCertificate(dir: string): { certPath: string; keyPath: string; certPem: string } {
  const certPath = path.join(dir, "test-cert.pem");
  const keyPath = path.join(dir, "test-key.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,DNS:callflow-companion.localhost,IP:127.0.0.1",
  ], { stdio: ["ignore", "ignore", "ignore"] });
  return { certPath, keyPath, certPem: fsSync.readFileSync(certPath, "utf8") };
}

function httpsRequestJson(
  urlString: string,
  caCert: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: init.method ?? "GET",
        headers: init.headers,
        ca: caCert,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function withServer(
  overrides: Partial<CompanionConfig>,
  fn: (started: StartedCompanion, baseUrl: string) => Promise<void>,
): Promise<void> {
  const tmpDir = overrides.tmpDir ?? (await makeTmpDir());
  const started = await startServer({ allowInsecureHttp: true, port: 0, tmpDir, ...overrides });
  const address = started.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(started, baseUrl);
  } finally {
    await started.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function pairAndGetToken(baseUrl: string, code: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json()) as { ok: boolean; token?: string };
  assert.equal(body.ok, true);
  return body.token as string;
}

test("GET /v1/health: 成功し、秘密情報・パスを含まない", async () => {
  await withServer({}, async (_started, baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/health`);
    assert.equal(res.status, 200);
    const body = await readJson<Record<string, unknown>>(res);
    assert.equal(body.ok, true);
    assert.equal(body.service, "callflow-companion");
    assert.equal(body.secure, false);
    assert.equal(body.phase, "audio-receive-only");
    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /token/i);
    assert.doesNotMatch(raw, /\/Users\//);
    assert.doesNotMatch(raw, /home/i);
  });
});

test("CORS: 許可originにはAccess-Control-Allow-Originが付与される", async () => {
  await withServer({}, async (_started, baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/health`, { headers: { Origin: ALLOWED_ORIGIN } });
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
  });
});

test("CORS: 未許可originにはAccess-Control-Allow-Originが付与されない", async () => {
  await withServer({}, async (_started, baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/health`, { headers: { Origin: DISALLOWED_ORIGIN } });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

test("CORS: ワイルドカードは一切使用しない", async () => {
  await withServer({}, async (_started, baseUrl) => {
    for (const origin of [ALLOWED_ORIGIN, DISALLOWED_ORIGIN, undefined]) {
      const res = await fetch(`${baseUrl}/v1/health`, { headers: origin ? { Origin: origin } : {} });
      const value = res.headers.get("access-control-allow-origin");
      assert.notEqual(value, "*");
    }
  });
});

test("OPTIONS: 許可originのプリフライトは204でAllow-Methods/Headersを返す", async () => {
  await withServer({}, async (_started, baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/audio`, {
      method: "OPTIONS",
      headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  });
});

test("OPTIONS: 未許可originのプリフライトは403でCORSヘッダーを付与しない", async () => {
  await withServer({}, async (_started, baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/audio`, {
      method: "OPTIONS",
      headers: { Origin: DISALLOWED_ORIGIN, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

test("POST /v1/pair: 正しいコードでトークンが発行される", async () => {
  await withServer({}, async (started, baseUrl) => {
    const token = await pairAndGetToken(baseUrl, started.pairing.currentCode);
    assert.ok(token.length >= 32);
  });
});

test("POST /v1/pair: 間違ったコードは401になる", async () => {
  await withServer({}, async (started, baseUrl) => {
    const wrong = started.pairing.currentCode === "000000" ? "111111" : "000000";
    const res = await fetch(`${baseUrl}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: wrong }),
    });
    assert.equal(res.status, 401);
    const body = await readJson<Record<string, unknown>>(res);
    assert.equal(body.ok, false);
    assert.equal(body.error, "invalid_code");
  });
});

test("POST /v1/pair: 期限切れコードは401 expired_codeになる", async () => {
  await withServer({ pairingCodeTtlMs: 5 }, async (started, baseUrl) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const res = await fetch(`${baseUrl}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: started.pairing.currentCode }),
    });
    const body = await readJson<Record<string, unknown>>(res);
    assert.equal(body.error, "expired_code");
  });
});

test("POST /v1/pair: 使用済みコードの再利用は拒否される", async () => {
  await withServer({}, async (started, baseUrl) => {
    await pairAndGetToken(baseUrl, started.pairing.currentCode);
    const res = await fetch(`${baseUrl}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: started.pairing.currentCode }),
    });
    const body = await readJson<Record<string, unknown>>(res);
    assert.equal(body.error, "code_already_used");
  });
});

test("POST /v1/pair: 失敗回数の上限を超えるとロックされる", async () => {
  await withServer({ pairingMaxAttempts: 2 }, async (started, baseUrl) => {
    const wrong = started.pairing.currentCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 2; i += 1) {
      await fetch(`${baseUrl}/v1/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: wrong }),
      });
    }
    const res = await fetch(`${baseUrl}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: started.pairing.currentCode }),
    });
    assert.equal(res.status, 429);
    const body = await readJson<Record<string, unknown>>(res);
    assert.equal(body.error, "too_many_attempts");
  });
});

test("POST /v1/audio: Authorizationが無いと401", async () => {
  await withServer({}, async (_started, baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/audio`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Origin: ALLOWED_ORIGIN },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(res.status, 401);
  });
});

test("POST /v1/audio: 無効なBearerトークンは401", async () => {
  await withServer({}, async (_started, baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/audio`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/webm",
        Origin: ALLOWED_ORIGIN,
        Authorization: "Bearer invalid-token-value",
      },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(res.status, 401);
  });
});

test("POST /v1/audio: originが無い場合は拒否される（forbidden_origin）", async () => {
  await withServer({}, async (started, baseUrl) => {
    const token = await pairAndGetToken(baseUrl, started.pairing.currentCode);
    const res = await fetch(`${baseUrl}/v1/audio`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Authorization: `Bearer ${token}` },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(res.status, 403);
    const body = await readJson<Record<string, unknown>>(res);
    assert.equal(body.error, "forbidden_origin");
  });
});

test("POST /v1/audio: 許可されたoriginと正しいトークンで音声を受信し、一時ファイルを削除する", async () => {
  const tmpDir = await makeTmpDir();
  await withServer({ tmpDir }, async (started, baseUrl) => {
    const token = await pairAndGetToken(baseUrl, started.pairing.currentCode);
    const res = await fetch(`${baseUrl}/v1/audio`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/webm;codecs=opus",
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${token}`,
        "X-CallFlow-Duration-Ms": "5000",
        "X-CallFlow-Company-Id": "company-1",
      },
      body: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    assert.equal(res.status, 200);
    const body = await readJson<Record<string, unknown>>(res);
    assert.equal(body.ok, true);
    assert.equal(body.sizeBytes, 8);
    assert.equal(body.mimeType, "audio/webm;codecs=opus");
    assert.equal(body.durationMs, 5000);
    assert.equal(body.temporaryFileDeleted, true);

    const raw = JSON.stringify(body);
    assert.doesNotMatch(raw, /\/Users\//);
    assert.doesNotMatch(raw, tmpDir.includes("/") ? new RegExp(tmpDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : /$^/);
    assert.doesNotMatch(raw, /Bearer/);

    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0, "受信・検証後は一時ファイルが残っていてはいけない");
  });
});

test("POST /v1/audio: 不正なMIME Typeは415", async () => {
  await withServer({}, async (started, baseUrl) => {
    const token = await pairAndGetToken(baseUrl, started.pairing.currentCode);
    const res = await fetch(`${baseUrl}/v1/audio`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(res.status, 415);
  });
});

test("POST /v1/audio: 空の音声は400", async () => {
  await withServer({}, async (started, baseUrl) => {
    const token = await pairAndGetToken(baseUrl, started.pairing.currentCode);
    const res = await fetch(`${baseUrl}/v1/audio`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      body: new Uint8Array([]),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /v1/audio: 上限を超えるサイズは413で一時ファイルを残さない", async () => {
  const tmpDir = await makeTmpDir();
  await withServer({ tmpDir, maxBodyBytes: 10 }, async (started, baseUrl) => {
    const token = await pairAndGetToken(baseUrl, started.pairing.currentCode);
    const res = await fetch(`${baseUrl}/v1/audio`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm", Origin: ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      body: new Uint8Array(1000).fill(1),
    });
    assert.equal(res.status, 413);
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0);
  });
});

test("起動時: tmpDirに残存していた一時ファイルは清掃される", async () => {
  const tmpDir = await makeTmpDir();
  await fs.writeFile(path.join(tmpDir, "leftover.webm"), "stale");
  await withServer({ tmpDir }, async (_started, baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/health`);
    assert.equal(res.status, 200);
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0, "起動時に残存ファイルは削除されている必要がある");
  });
});

test("終了時: closeを呼ぶとtmpDir内の残存ファイルも清掃される", async () => {
  const tmpDir = await makeTmpDir();
  const started = await startServer({ allowInsecureHttp: true, port: 0, tmpDir });
  try {
    // サーバー起動後に紛れ込んだファイル（想定外の残存物）を模擬する。
    await fs.writeFile(path.join(tmpDir, "unexpected.webm"), "data");
    await started.close();
    const entries = await fs.readdir(tmpDir);
    assert.equal(entries.length, 0, "終了時に残存ファイルは削除されている必要がある");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("起動失敗: allowInsecureHttpが無くTLS証明書も無い場合は起動しない", async () => {
  const tmpDir = await makeTmpDir();
  try {
    // tlsCertPath/tlsKeyPathを明示的に「存在しないパス」に固定する。
    // 省略するとloadConfig()の既定パス（実ホームディレクトリ配下）を見に行ってしまい、
    // このマシンで実際にmkcert証明書をセットアップ済みだとテストが偽陽性で失敗するため。
    await assert.rejects(
      () =>
        startServer({
          port: 0,
          tmpDir,
          allowInsecureHttp: false,
          secure: false,
          tlsCertPath: path.join(tmpDir, "does-not-exist-cert.pem"),
          tlsKeyPath: path.join(tmpDir, "does-not-exist-key.pem"),
        }),
      /TLS証明書|安全でないHTTPモード/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ===========================================================
// HTTPS（Phase 2B）
// テスト用証明書はこのテストの実行時にのみopensslで自己署名生成し、
// 実際のmkcert CAROOT・秘密鍵は一切使用しない。
// ===========================================================

test("起動失敗: 秘密鍵が存在しない場合はHTTPSで起動しない", async () => {
  const tmpDir = await makeTmpDir();
  const certDir = await makeTmpDir();
  try {
    const { certPath } = generateTestCertificate(certDir);
    await assert.rejects(
      () =>
        startServer({
          port: 0,
          tmpDir,
          allowInsecureHttp: false,
          tlsCertPath: certPath,
          tlsKeyPath: path.join(certDir, "does-not-exist.pem"),
        }),
      /TLS秘密鍵/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(certDir, { recursive: true, force: true });
  }
});

test("起動失敗: 証明書が存在しない場合はHTTPSで起動しない", async () => {
  const tmpDir = await makeTmpDir();
  const certDir = await makeTmpDir();
  try {
    const { keyPath } = generateTestCertificate(certDir);
    await assert.rejects(
      () =>
        startServer({
          port: 0,
          tmpDir,
          allowInsecureHttp: false,
          tlsCertPath: path.join(certDir, "does-not-exist.pem"),
          tlsKeyPath: keyPath,
        }),
      /TLS証明書/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(certDir, { recursive: true, force: true });
  }
});

test("起動失敗: 不正な証明書（PEMとして解釈できない）ではHTTPSで起動しない", async () => {
  const tmpDir = await makeTmpDir();
  const certDir = await makeTmpDir();
  try {
    const { keyPath } = generateTestCertificate(certDir);
    const brokenCertPath = path.join(certDir, "broken-cert.pem");
    await fs.writeFile(brokenCertPath, "this is not a certificate");
    await assert.rejects(
      () =>
        startServer({
          port: 0,
          tmpDir,
          allowInsecureHttp: false,
          tlsCertPath: brokenCertPath,
          tlsKeyPath: keyPath,
        }),
      /不正/,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(certDir, { recursive: true, force: true });
  }
});

test("HTTPSサーバー起動: 有効な証明書・秘密鍵があれば起動し、secure=true・127.0.0.1にのみbindする", async () => {
  const tmpDir = await makeTmpDir();
  const certDir = await makeTmpDir();
  try {
    const { certPath, keyPath, certPem } = generateTestCertificate(certDir);
    const started = await startServer({
      port: 0,
      tmpDir,
      allowInsecureHttp: false,
      tlsCertPath: certPath,
      tlsKeyPath: keyPath,
    });
    try {
      assert.equal(started.config.secure, true);
      const address = started.server.address();
      assert.equal(typeof address === "object" && address ? address.address : null, "127.0.0.1");

      const port = typeof address === "object" && address ? address.port : 0;
      const res = await httpsRequestJson(`https://localhost:${port}/v1/health`, certPem);
      assert.equal(res.status, 200);
      const body = res.body as { ok: boolean; secure: boolean };
      assert.equal(body.ok, true);
      assert.equal(body.secure, true, "HTTPSモードではhealthのsecureはtrueである必要がある");

      const raw = JSON.stringify(body);
      assert.doesNotMatch(raw, /BEGIN CERTIFICATE|BEGIN PRIVATE KEY/);
    } finally {
      await started.close();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(certDir, { recursive: true, force: true });
  }
});

test("HTTPS CORS: 本番originが許可される", async () => {
  const tmpDir = await makeTmpDir();
  const certDir = await makeTmpDir();
  try {
    const { certPath, keyPath, certPem } = generateTestCertificate(certDir);
    const started = await startServer({ port: 0, tmpDir, allowInsecureHttp: false, tlsCertPath: certPath, tlsKeyPath: keyPath });
    try {
      const address = started.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const res = await httpsRequestJson(`https://localhost:${port}/v1/health`, certPem, {
        headers: { Origin: PRODUCTION_ORIGIN },
      });
      assert.equal(res.headers["access-control-allow-origin"], PRODUCTION_ORIGIN);
    } finally {
      await started.close();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(certDir, { recursive: true, force: true });
  }
});

test("HTTPS CORS: 未許可originは引き続き拒否される", async () => {
  const tmpDir = await makeTmpDir();
  const certDir = await makeTmpDir();
  try {
    const { certPath, keyPath, certPem } = generateTestCertificate(certDir);
    const started = await startServer({ port: 0, tmpDir, allowInsecureHttp: false, tlsCertPath: certPath, tlsKeyPath: keyPath });
    try {
      const address = started.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const res = await httpsRequestJson(`https://localhost:${port}/v1/health`, certPem, {
        headers: { Origin: DISALLOWED_ORIGIN },
      });
      assert.equal(res.headers["access-control-allow-origin"], undefined);
    } finally {
      await started.close();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(certDir, { recursive: true, force: true });
  }
});

test("PNA: 許可originがAccess-Control-Request-Private-Networkを送るとAccess-Control-Allow-Private-Networkを返す", async () => {
  const tmpDir = await makeTmpDir();
  const certDir = await makeTmpDir();
  try {
    const { certPath, keyPath, certPem } = generateTestCertificate(certDir);
    const started = await startServer({ port: 0, tmpDir, allowInsecureHttp: false, tlsCertPath: certPath, tlsKeyPath: keyPath });
    try {
      const address = started.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const res = await httpsRequestJson(`https://localhost:${port}/v1/audio`, certPem, {
        method: "OPTIONS",
        headers: {
          Origin: PRODUCTION_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Private-Network": "true",
        },
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers["access-control-allow-private-network"], "true");
    } finally {
      await started.close();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(certDir, { recursive: true, force: true });
  }
});

test("PNA: 未許可originにはAccess-Control-Allow-Private-Networkを返さない", async () => {
  const tmpDir = await makeTmpDir();
  const certDir = await makeTmpDir();
  try {
    const { certPath, keyPath, certPem } = generateTestCertificate(certDir);
    const started = await startServer({ port: 0, tmpDir, allowInsecureHttp: false, tlsCertPath: certPath, tlsKeyPath: keyPath });
    try {
      const address = started.server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const res = await httpsRequestJson(`https://localhost:${port}/v1/audio`, certPem, {
        method: "OPTIONS",
        headers: {
          Origin: DISALLOWED_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Private-Network": "true",
        },
      });
      assert.equal(res.status, 403);
      assert.equal(res.headers["access-control-allow-private-network"], undefined);
    } finally {
      await started.close();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(certDir, { recursive: true, force: true });
  }
});
