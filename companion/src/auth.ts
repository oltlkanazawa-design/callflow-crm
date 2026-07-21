// Authorizationヘッダーの検証。トークンそのものの発行・保管はpairing.tsが担う。

import type { PairingManager } from "./pairing.ts";

export function isAuthorized(pairingManager: PairingManager, authorizationHeader: string | undefined): boolean {
  return pairingManager.verifyToken(authorizationHeader);
}
