/**
 * Desktop "Mobile access" contract (D663 / ADR 0331): the renderer's typed
 * view of the opt-in relay link and the paired phones. No credential, token,
 * or hash ever crosses this boundary except the pairing QR payload, which is
 * returned once, transiently, by `createPairing`.
 */
import { RACP_PAIRING_TOKEN_PREFIX } from "./racp.js";

export type MobileAccessLinkState =
  | "disabled"
  | "not-enrolled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export type MobileAccessStatus = {
  enabled: boolean;
  enrolled: boolean;
  /** Pinned relay origin (`https://…`), when enrolled. */
  relayOrigin?: string;
  hostId: string;
  hostLabel: string;
  linkState: MobileAccessLinkState;
  /** A stable error code for the last link failure; never a server message. */
  lastErrorCode?: string;
  connectedPhones: number;
  encryptionAvailable: boolean;
};

export type MobileAccessEnrollRequest = {
  relayOrigin: string;
  enrollmentCode: string;
  hostLabel?: string;
};

export type MobileAccessSetEnabledRequest = { enabled: boolean };

export type MobileAccessPairing = {
  /** The JSON string rendered as the QR code. Display only; never persist. */
  payload: string;
  expiresAt: string;
};

export type MobileDeviceSummary = {
  deviceId: string;
  label: string;
  createdAt: string;
  lastSeenAt?: string;
  connected: boolean;
  pushEnabled: boolean;
};

export type MobileAccessRevokeRequest = { deviceId: string };

/** The QR payload of profile §5. */
export type MobilePairingPayload = {
  v: 1;
  relay: string;
  hostId: string;
  pairingToken: string;
  hostLabel: string;
};

export class MobileAccessInputError extends Error {
  readonly errorCode = "INVALID_ARGUMENT";
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

/**
 * Normalize a user-typed relay origin to `https://host[:port]`. Anything but
 * an https origin without credentials, path, query, or fragment is refused,
 * so a token can never be sent over plain HTTP or to a path the user did not
 * mean.
 */
export function normalizeRelayOrigin(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MobileAccessInputError("the relay address is not a valid URL", "relayOrigin");
  }
  if (url.protocol !== "https:") throw new MobileAccessInputError("the relay address must use https", "relayOrigin");
  if (url.username || url.password) throw new MobileAccessInputError("the relay address must not contain credentials", "relayOrigin");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new MobileAccessInputError("the relay address must be an origin without a path", "relayOrigin");
  }
  if (!url.hostname) throw new MobileAccessInputError("the relay address has no host", "relayOrigin");
  return url.origin;
}

export function buildMobilePairingPayload(input: Omit<MobilePairingPayload, "v">): string {
  const payload: MobilePairingPayload = {
    v: 1,
    relay: normalizeRelayOrigin(input.relay),
    hostId: input.hostId,
    pairingToken: input.pairingToken,
    hostLabel: input.hostLabel,
  };
  return JSON.stringify(payload);
}

/** Parse and validate a scanned QR payload; `null` when it is not one. */
export function parseMobilePairingPayload(raw: string): MobilePairingPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  const { relay, hostId, pairingToken, hostLabel } = record;
  if (typeof relay !== "string" || typeof hostId !== "string" || typeof pairingToken !== "string" || typeof hostLabel !== "string") {
    return null;
  }
  if (!hostId || !pairingToken.startsWith(RACP_PAIRING_TOKEN_PREFIX)) return null;
  try {
    return { v: 1, relay: normalizeRelayOrigin(relay), hostId, pairingToken, hostLabel };
  } catch {
    return null;
  }
}
