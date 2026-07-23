// JSONレスポンス送出の共通ヘルパー。秘密情報・絶対パスを一切含めないことをここで一元的に担保する。

import type { ServerResponse } from "node:http";

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload).toString(),
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse, statusCode: number, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, ...extraHeaders });
  res.end();
}
