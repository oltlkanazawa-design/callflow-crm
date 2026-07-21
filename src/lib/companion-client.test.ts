import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCompanionBaseUrl,
  DEFAULT_COMPANION_URL,
  loadStoredToken,
  storeToken,
  clearStoredToken,
  checkCompanionHealth,
  pairWithCompanion,
  uploadRecordingToCompanion,
  companionErrorMessage,
  CompanionClientError,
  validateCompanionUrl,
} from "./companion-client.ts";

function withMockFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// このファイルのhttp://ベースURLを使うテストは、開発用の安全でないHTTPモードを
// 模擬するためのもの。validateCompanionUrlの実地チェックはcompanion-url専用のテストで行う。
async function withInsecureHttpAllowed<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP;
  process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP = "true";
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP;
    else process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_ALLOW_INSECURE_HTTP = original;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------
// URL設定
// ---------------------------------------------------------
test("getCompanionBaseUrl: 環境変数未設定時は既定のhttps://callflow-companion.localhost:4318", () => {
  const original = process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_URL;
  delete process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_URL;
  try {
    assert.equal(getCompanionBaseUrl(), DEFAULT_COMPANION_URL);
  } finally {
    if (original !== undefined) process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_URL = original;
  }
});

test("getCompanionBaseUrl: 環境変数が設定されていればそれを使う（末尾スラッシュは除去）", () => {
  const original = process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_URL;
  process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_URL = "http://127.0.0.1:4318/";
  try {
    assert.equal(getCompanionBaseUrl(), "http://127.0.0.1:4318");
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_URL;
    else process.env.NEXT_PUBLIC_CALLFLOW_COMPANION_URL = original;
  }
});

// ---------------------------------------------------------
// token保存・取得・削除（SSR安全 + ブラウザ環境模擬）
// ---------------------------------------------------------
test("loadStoredToken: windowが無い環境（SSR）ではnullを返し例外を投げない", () => {
  assert.equal(typeof window, "undefined");
  assert.equal(loadStoredToken(), null);
});

test("storeToken/loadStoredToken/clearStoredToken: window.localStorageがある環境では保存・取得・削除できる", () => {
  const store = new Map<string, string>();
  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  // @ts-expect-error テスト用にwindowを一時的に定義する
  globalThis.window = fakeWindow;
  try {
    assert.equal(loadStoredToken(), null);
    storeToken("token-abc123");
    assert.equal(loadStoredToken(), "token-abc123");
    clearStoredToken();
    assert.equal(loadStoredToken(), null);
  } finally {
    // @ts-expect-error 後始末
    delete globalThis.window;
  }
});

// ---------------------------------------------------------
// health check
// ---------------------------------------------------------
test("checkCompanionHealth: 成功時にレスポンスボディを返す", async () => {
  await withInsecureHttpAllowed(() =>
    withMockFetch(
      (async () => jsonResponse(200, { ok: true, service: "callflow-companion", version: "0.1.0", secure: false, phase: "audio-receive-only" })) as typeof fetch,
      async () => {
        const health = await checkCompanionHealth("http://127.0.0.1:4318");
        assert.equal(health.service, "callflow-companion");
        assert.equal(health.secure, false);
      },
    ),
  );
});

test("checkCompanionHealth: 失敗時はCompanionClientErrorを投げる", async () => {
  await withInsecureHttpAllowed(() =>
    withMockFetch(
      (async () => jsonResponse(500, { ok: false, error: "internal", message: "error" })) as typeof fetch,
      async () => {
        await assert.rejects(() => checkCompanionHealth("http://127.0.0.1:4318"), CompanionClientError);
      },
    ),
  );
});

// ---------------------------------------------------------
// pairing
// ---------------------------------------------------------
test("pairWithCompanion: 成功時にトークンを返す", async () => {
  await withInsecureHttpAllowed(() =>
    withMockFetch(
      (async () => jsonResponse(200, { ok: true, token: "tok_xyz", tokenType: "Bearer" })) as typeof fetch,
      async () => {
        const token = await pairWithCompanion("http://127.0.0.1:4318", "123456");
        assert.equal(token, "tok_xyz");
      },
    ),
  );
});

test("pairWithCompanion: 間違ったコードはinvalid_codeとしてCompanionClientErrorを投げる", async () => {
  await withInsecureHttpAllowed(() =>
    withMockFetch(
      (async () => jsonResponse(401, { ok: false, error: "invalid_code", message: "..." })) as typeof fetch,
      async () => {
        try {
          await pairWithCompanion("http://127.0.0.1:4318", "000000");
          assert.fail("エラーが投げられるべき");
        } catch (error) {
          assert.ok(error instanceof CompanionClientError);
          assert.equal((error as CompanionClientError).code, "invalid_code");
          assert.equal((error as CompanionClientError).httpStatus, 401);
        }
      },
    ),
  );
});

// ---------------------------------------------------------
// 音声アップロード：ヘッダー・MIME・メタデータ
// ---------------------------------------------------------
test("uploadRecordingToCompanion: Authorization/Content-Type/メタデータヘッダーが正しく送信される", async () => {
  let capturedInit: RequestInit | undefined;
  await withInsecureHttpAllowed(() =>
    withMockFetch(
      (async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return jsonResponse(200, {
          ok: true,
          recordingId: "r1",
          mimeType: "audio/webm;codecs=opus",
          sizeBytes: 10,
          durationMs: 5000,
          temporaryFileDeleted: true,
          message: "ok",
        });
      }) as typeof fetch,
      async () => {
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" });
        const result = await uploadRecordingToCompanion("http://127.0.0.1:4318", "my-token", blob, {
          recordingId: "rec-1",
          companyId: "company-1",
          durationMs: 5432,
        });
        assert.equal(result.ok, true);
        const headers = capturedInit?.headers as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer my-token");
        assert.equal(headers["Content-Type"], "audio/webm;codecs=opus");
        assert.equal(headers["X-CallFlow-Recording-Id"], "rec-1");
        assert.equal(headers["X-CallFlow-Company-Id"], "company-1");
        assert.equal(headers["X-CallFlow-Duration-Ms"], "5432");
      },
    ),
  );
});

test("uploadRecordingToCompanion: companyIdがnullの場合はX-CallFlow-Company-Idヘッダーを付与しない", async () => {
  let capturedInit: RequestInit | undefined;
  await withInsecureHttpAllowed(() =>
    withMockFetch(
      (async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return jsonResponse(200, { ok: true, recordingId: "r1", mimeType: "audio/webm", sizeBytes: 1, durationMs: 0, temporaryFileDeleted: true, message: "ok" });
      }) as typeof fetch,
      async () => {
        const blob = new Blob([new Uint8Array([1])], { type: "audio/webm" });
        await uploadRecordingToCompanion("http://127.0.0.1:4318", "tok", blob, { recordingId: "r", companyId: null, durationMs: 0 });
        const headers = capturedInit?.headers as Record<string, string>;
        assert.equal("X-CallFlow-Company-Id" in headers, false);
      },
    ),
  );
});

// ---------------------------------------------------------
// タイムアウト・ネットワークエラー
// ---------------------------------------------------------
test("checkCompanionHealth: タイムアウト時はAbortErrorとなり、日本語メッセージに変換できる", async () => {
  await withInsecureHttpAllowed(() =>
    withMockFetch(
      ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        })) as unknown as typeof fetch,
      async () => {
        try {
          await checkCompanionHealth("http://127.0.0.1:4318", { timeoutMs: 20 });
          assert.fail("タイムアウトするはず");
        } catch (error) {
          assert.equal(companionErrorMessage(error), companionErrorMessage(new DOMException("x", "AbortError")));
        }
      },
    ),
  );
});

test("companionErrorMessage: ネットワークエラー（TypeError）は接続失敗メッセージになる", () => {
  const message = companionErrorMessage(new TypeError("fetch failed"));
  assert.match(message, /接続できませんでした/);
});

test("companionErrorMessage: unauthorizedはペアリング解除の案内を含む", () => {
  const message = companionErrorMessage(new CompanionClientError("unauthorized", "x", 401));
  assert.match(message, /ペアリングを解除/);
});

test("companionErrorMessage: 未知のエラーでも例外を投げず既定メッセージを返す", () => {
  assert.equal(typeof companionErrorMessage(new Error("something else")), "string");
  assert.equal(typeof companionErrorMessage("not an error object"), "string");
  assert.equal(typeof companionErrorMessage(null), "string");
});

// ---------------------------------------------------------
// Companion URL検証
// ---------------------------------------------------------
test("validateCompanionUrl: 本番相当のhttps://callflow-companion.localhost:4318は許可", () => {
  assert.deepEqual(validateCompanionUrl("https://callflow-companion.localhost:4318"), { ok: true });
});

test("validateCompanionUrl: https://localhost:4318も許可してよい", () => {
  assert.deepEqual(validateCompanionUrl("https://localhost:4318"), { ok: true });
});

test("validateCompanionUrl: 開発フラグ無しのhttp URLは拒否", () => {
  assert.deepEqual(validateCompanionUrl("http://127.0.0.1:4318"), { ok: false, reason: "insecure_http_not_allowed" });
});

test("validateCompanionUrl: 開発フラグありならhttp://127.0.0.1:4318を許可", () => {
  assert.deepEqual(validateCompanionUrl("http://127.0.0.1:4318", { allowInsecureHttp: true }), { ok: true });
});

test("validateCompanionUrl: 外部ドメインは拒否", () => {
  assert.deepEqual(validateCompanionUrl("https://evil.example.com:4318"), { ok: false, reason: "host_not_allowed" });
});

test("validateCompanionUrl: LAN IPは拒否", () => {
  assert.deepEqual(validateCompanionUrl("https://192.168.1.10:4318"), { ok: false, reason: "host_not_allowed" });
  assert.deepEqual(validateCompanionUrl("http://192.168.1.10:4318", { allowInsecureHttp: true }), {
    ok: false,
    reason: "host_not_allowed",
  });
});

test("validateCompanionUrl: 任意ポートは拒否（4318以外）", () => {
  assert.deepEqual(validateCompanionUrl("https://callflow-companion.localhost:9999"), {
    ok: false,
    reason: "port_not_allowed",
  });
});

test("validateCompanionUrl: URL内のユーザー名・パスワードは拒否", () => {
  assert.deepEqual(validateCompanionUrl("https://user:pass@callflow-companion.localhost:4318"), {
    ok: false,
    reason: "credentials_not_allowed",
  });
});

test("validateCompanionUrl: queryやfragment付きは拒否", () => {
  assert.deepEqual(validateCompanionUrl("https://callflow-companion.localhost:4318?x=1"), {
    ok: false,
    reason: "query_or_fragment_not_allowed",
  });
  assert.deepEqual(validateCompanionUrl("https://callflow-companion.localhost:4318#frag"), {
    ok: false,
    reason: "query_or_fragment_not_allowed",
  });
});

test("validateCompanionUrl: 不正なURL文字列はinvalid_url", () => {
  assert.deepEqual(validateCompanionUrl("not a url"), { ok: false, reason: "invalid_url" });
});

test("validateCompanionUrl: http/https以外のプロトコルは拒否", () => {
  assert.deepEqual(validateCompanionUrl("ftp://localhost:4318"), { ok: false, reason: "protocol_not_allowed" });
});

test("checkCompanionHealth/pairWithCompanion/uploadRecordingToCompanion: 不正なCompanion URLは送信前にinvalid_companion_urlで拒否する", async () => {
  await assert.rejects(() => checkCompanionHealth("https://evil.example.com:4318"), (error: unknown) => {
    return error instanceof CompanionClientError && error.code === "invalid_companion_url";
  });
  await assert.rejects(() => pairWithCompanion("https://evil.example.com:4318", "123456"), (error: unknown) => {
    return error instanceof CompanionClientError && error.code === "invalid_companion_url";
  });
  const blob = new Blob([new Uint8Array([1])], { type: "audio/webm" });
  await assert.rejects(
    () => uploadRecordingToCompanion("https://evil.example.com:4318", "tok", blob, { recordingId: "r", companyId: null, durationMs: 0 }),
    (error: unknown) => error instanceof CompanionClientError && error.code === "invalid_companion_url",
  );
});
