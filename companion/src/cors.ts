// Origin完全一致によるCORS制御。ワイルドカードは使用しない。

export const ALLOWED_METHODS = "GET, POST, OPTIONS";
export const ALLOWED_HEADERS =
  "Authorization, Content-Type, X-CallFlow-Recording-Id, X-CallFlow-Company-Id, X-CallFlow-Duration-Ms";
export const PREFLIGHT_MAX_AGE_SECONDS = 600;

export function isOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

/** 許可されたOriginの場合のみCORSヘッダーを返す。許可されない場合はnull（ヘッダーを付けない）。 */
export function corsHeadersFor(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> | null {
  if (!isOriginAllowed(origin, allowedOrigins)) return null;
  return {
    "Access-Control-Allow-Origin": origin as string,
    Vary: "Origin",
  };
}

export function preflightHeadersFor(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> | null {
  const base = corsHeadersFor(origin, allowedOrigins);
  if (!base) return null;
  return {
    ...base,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
  };
}
