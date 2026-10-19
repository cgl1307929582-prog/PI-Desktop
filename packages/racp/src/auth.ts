import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { Principal } from "@pi-desktop/agent-host";
import { RACP_DEVICE_TOKEN_PREFIX, RACP_PAIRING_TOKEN_PREFIX, type RacpRole } from "@pi-desktop/shared";

/**
 * Credentials for the header profile (security §3.1, §3.4). A device token
 * is the long-lived credential a paired desktop presents on every upgrade; a
 * pairing token is single-use, expiring, and only good for `connection/pair`.
 * Neither ever appears in a URL; both are stored hashed on the Host.
 */
export type DeviceRecord = {
  deviceId: string;
  label: string;
  roles: RacpRole[];
  /** SHA-256 of the token, hex. */
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
  /**
   * Set for a phone paired through the mobile relay profile (D663). Such a
   * credential authenticates only on a relayed connection and never receives
   * the paired-device ceiling exemption.
   */
  profile?: ConnectionProfile;
};

/** The access path that admitted a connection; set by the access layer, never by the client. */
export type ConnectionProfile = "mobile";

export type PairingRecord = {
  tokenHash: string;
  expiresAt: string;
  /** Set once exchanged; a second exchange is refused. */
  consumedAt?: string;
  /** The profile the minted device belongs to; absent for SSH bootstrap pairing. */
  profile?: ConnectionProfile;
};

/** Durable credential storage; `pi-host` keeps it under its data directory. */
export interface DeviceCredentialStore {
  findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null>;
  saveDevice(record: DeviceRecord): Promise<void>;
  touchDevice(deviceId: string, seenAt: string): Promise<void>;
  revokeDevice(deviceId: string, revokedAt: string): Promise<boolean>;
  listDevices(): Promise<DeviceRecord[]>;
  findPairing(tokenHash: string): Promise<PairingRecord | null>;
  savePairing(record: PairingRecord): Promise<void>;
  consumePairing(tokenHash: string, consumedAt: string): Promise<boolean>;
  /** Every stored pairing record; optional so existing stores stay valid. */
  listPairings?(): Promise<PairingRecord[]>;
}

export class MemoryCredentialStore implements DeviceCredentialStore {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly pairings = new Map<string, PairingRecord>();

  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
    for (const device of this.devices.values()) {
      if (device.tokenHash === tokenHash) return device;
    }
    return null;
  }
  async saveDevice(record: DeviceRecord): Promise<void> {
    this.devices.set(record.deviceId, record);
  }
  async touchDevice(deviceId: string, seenAt: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device) device.lastSeenAt = seenAt;
  }
  async revokeDevice(deviceId: string, revokedAt: string): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt) return false;
    device.revokedAt = revokedAt;
    return true;
  }
  async listDevices(): Promise<DeviceRecord[]> {
    return [...this.devices.values()];
  }
  async findPairing(tokenHash: string): Promise<PairingRecord | null> {
    return this.pairings.get(tokenHash) ?? null;
  }
  async savePairing(record: PairingRecord): Promise<void> {
    this.pairings.set(record.tokenHash, record);
  }
  async consumePairing(tokenHash: string, consumedAt: string): Promise<boolean> {
    const pairing = this.pairings.get(tokenHash);
    if (!pairing || pairing.consumedAt) return false;
    pairing.consumedAt = consumedAt;
    return true;
  }
  async listPairings(): Promise<PairingRecord[]> {
    return [...this.pairings.values()];
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newDeviceToken(): string {
  return `${RACP_DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function newPairingToken(): string {
  return `${RACP_PAIRING_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export function isDeviceToken(token: string): boolean {
  return token.startsWith(RACP_DEVICE_TOKEN_PREFIX);
}

export function isPairingToken(token: string): boolean {
  return token.startsWith(RACP_PAIRING_TOKEN_PREFIX);
}

/** Constant-time comparison of two hex digests of equal length. */
export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `Authorization: Bearer <token>`; anything else is not a credential. */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match ? match[1]! : null;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  const family = isIP(bare);
  if (family === 4) return bare.startsWith("127.");
  if (family === 6) return bare === "::1";
  return false;
}

/** What the upgrade handler learned about a connection before any RPC ran. */
export type ConnectionAuth =
  | { kind: "device"; principal: Principal; device: DeviceRecord; profile?: ConnectionProfile }
  | { kind: "pairing"; principal: Principal; tokenHash: string; profile?: ConnectionProfile };

export type AuthenticateInput = {
  authorization: string | undefined;
  /** Rejected outright: a token in the URL is never accepted (security §3.1). */
  urlHasToken: boolean;
  connectionId: string;
  /** Set by the access layer that admitted the connection (the relay Host link). */
  profile?: ConnectionProfile;
};

/** Roles a phone receives at pairing (profile §5–§6); never `owner`. */
export const MOBILE_DEVICE_ROLES: readonly RacpRole[] = ["controller", "approver"];

/** Hashes the relay may admit: active device tokens and unexpired pairing tokens. */
export type ActiveCredentialHashes = { tokenHashes: string[]; pairingHashes: string[] };

/**
 * The header-profile authenticator. A device token yields the device's
 * principal; a still-valid pairing token yields an unprivileged principal
 * that may only call `connection/pair`.
 */
export class DeviceTokenAuthenticator {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: DeviceCredentialStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Observe credential changes (pairing issued or exchanged, device revoked). */
  onCredentialsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tell observers that the active credential set changed. */
  notifyCredentialsChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // An observer failure must not break pairing; observers log their own errors.
      }
    }
  }

  async authenticate(input: AuthenticateInput): Promise<ConnectionAuth | null> {
    if (input.urlHasToken) return null;
    const token = bearerToken(input.authorization);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const profile = input.profile;
    if (isDeviceToken(token)) {
      const device = await this.store.findDeviceByTokenHash(tokenHash);
      if (!device || device.revokedAt || !hashesEqual(device.tokenHash, tokenHash)) return null;
      // A credential is valid only on the access path it was paired for.
      if ((device.profile ?? undefined) !== profile) return null;
      await this.store.touchDevice(device.deviceId, new Date(this.now()).toISOString());
      const mobile = device.profile === "mobile";
      return {
        kind: "device",
        device,
        ...(profile ? { profile } : {}),
        principal: {
          subject: device.deviceId,
          roles: [...device.roles],
          // Only the SSH-paired desktop device is exempt from the remote ceiling.
          pairedDevice: !mobile,
          ...(mobile ? { mobile: true } : {}),
          connectionId: input.connectionId,
        },
      };
    }
    if (isPairingToken(token)) {
      const pairing = await this.store.findPairing(tokenHash);
      if (!pairing || pairing.consumedAt || Date.parse(pairing.expiresAt) <= this.now()) return null;
      if ((pairing.profile ?? undefined) !== profile) return null;
      return {
        kind: "pairing",
        tokenHash,
        ...(profile ? { profile } : {}),
        principal: {
          subject: `pairing:${tokenHash.slice(0, 12)}`,
          roles: [],
          ...(profile === "mobile" ? { mobile: true } : {}),
          connectionId: input.connectionId,
        },
      };
    }
    return null;
  }

  /** Mint a single-use pairing token; the caller hands it over the bootstrap channel or a QR code. */
  async issuePairingToken(
    lifetimeMs: number,
    options: { profile?: ConnectionProfile } = {},
  ): Promise<{ token: string; expiresAt: string }> {
    const token = newPairingToken();
    const expiresAt = new Date(this.now() + lifetimeMs).toISOString();
    await this.store.savePairing({ tokenHash: hashToken(token), expiresAt, ...(options.profile ? { profile: options.profile } : {}) });
    this.notifyCredentialsChanged();
    return { token, expiresAt };
  }

  /** Active device-token hashes and unexpired pairing hashes for one profile (profile §4 rule 2). */
  async activeHashes(profile: ConnectionProfile): Promise<ActiveCredentialHashes> {
    const devices = await this.store.listDevices();
    const pairings = (await this.store.listPairings?.()) ?? [];
    const now = this.now();
    return {
      tokenHashes: devices.filter((device) => !device.revokedAt && device.profile === profile).map((device) => device.tokenHash),
      pairingHashes: pairings
        .filter((pairing) => !pairing.consumedAt && pairing.profile === profile && Date.parse(pairing.expiresAt) > now)
        .map((pairing) => pairing.tokenHash),
    };
  }

  /** Revoke one device and tell observers; returns false when it was unknown or already revoked. */
  async revoke(deviceId: string): Promise<boolean> {
    const revoked = await this.store.revokeDevice(deviceId, new Date(this.now()).toISOString());
    if (revoked) this.notifyCredentialsChanged();
    return revoked;
  }

  /**
   * Exchange a pairing token (already authenticated on the upgrade) for a
   * device credential. A mobile pairing always mints `controller` +
   * `approver`, whatever the caller asks for.
   */
  async pair(tokenHash: string, label: string, roles: RacpRole[]): Promise<{ deviceId: string; token: string; roles: RacpRole[] }> {
    const consumedAt = new Date(this.now()).toISOString();
    const pairing = await this.store.findPairing(tokenHash);
    if (!pairing) throw pairingError("PAIRING_FAILED", "the pairing token is unknown");
    if (Date.parse(pairing.expiresAt) <= this.now()) {
      throw pairingError("PAIRING_TOKEN_EXPIRED", "the pairing token has expired");
    }
    if (!(await this.store.consumePairing(tokenHash, consumedAt))) {
      throw pairingError("PAIRING_FAILED", "the pairing token was already used");
    }
    const token = newDeviceToken();
    const deviceId = `dev_${randomBytes(9).toString("base64url")}`;
    const mobile = pairing.profile === "mobile";
    const grantedRoles = mobile ? [...MOBILE_DEVICE_ROLES] : roles;
    await this.store.saveDevice({
      deviceId,
      label: mobile ? label.slice(0, 80) : label,
      roles: grantedRoles,
      tokenHash: hashToken(token),
      createdAt: consumedAt,
      ...(mobile ? { profile: "mobile" as const } : {}),
    });
    this.notifyCredentialsChanged();
    return { deviceId, token, roles: grantedRoles };
  }
}

function pairingError(code: string, message: string): Error & { errorCode: string } {
  return Object.assign(new Error(message), { errorCode: code });
}
