/**
 * Persistence for Mobile access (D663 / ADR 0331) under
 * `<dataDir>/mobile-access.json`, owner-readable only.
 *
 * - The relay link credential (`prh1.`) is stored only encrypted through the
 *   injected OS-keychain port; encryption unavailable means enrollment fails
 *   closed rather than writing plaintext.
 * - Phone device tokens are stored as SHA-256 hashes (security §3.4).
 * - Pairing tokens live in memory only: they expire in five minutes and a
 *   restart simply invalidates an unused QR code.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DeviceCredentialStore, DeviceRecord, PairingRecord } from "@pi-desktop/racp";
import type { PushEnvironment } from "@pi-desktop/shared";

import type { EncryptionPort } from "../remote/remote-host-registry.js";

export type MobilePushRegistration = { environment: PushEnvironment; registeredAt: string };

type MobileAccessFile = {
  version: 1;
  enabled: boolean;
  hostId: string;
  hostLabel?: string;
  relayOrigin?: string;
  relayId?: string;
  /** base64 of the OS-keychain-encrypted relay link credential. */
  credential?: string;
  devices: DeviceRecord[];
  push: Record<string, MobilePushRegistration>;
};

export type MobileAccessConfig = {
  enabled: boolean;
  hostId: string;
  hostLabel?: string;
  relayOrigin?: string;
  relayId?: string;
  enrolled: boolean;
};

function emptyFile(): MobileAccessFile {
  return { version: 1, enabled: false, hostId: `host_${randomBytes(12).toString("base64url")}`, devices: [], push: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitize(value: unknown): MobileAccessFile | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.hostId !== "string" || !value.hostId) return null;
  const devices = Array.isArray(value.devices)
    ? value.devices.filter(
        (device): device is DeviceRecord =>
          isRecord(device) && typeof device.deviceId === "string" && typeof device.tokenHash === "string" && Array.isArray(device.roles),
      )
    : [];
  const push: Record<string, MobilePushRegistration> = {};
  if (isRecord(value.push)) {
    for (const [deviceId, entry] of Object.entries(value.push)) {
      if (isRecord(entry) && (entry.environment === "sandbox" || entry.environment === "production") && typeof entry.registeredAt === "string") {
        push[deviceId] = { environment: entry.environment, registeredAt: entry.registeredAt };
      }
    }
  }
  return {
    version: 1,
    enabled: value.enabled === true,
    hostId: value.hostId,
    ...(typeof value.hostLabel === "string" ? { hostLabel: value.hostLabel } : {}),
    ...(typeof value.relayOrigin === "string" ? { relayOrigin: value.relayOrigin } : {}),
    ...(typeof value.relayId === "string" ? { relayId: value.relayId } : {}),
    ...(typeof value.credential === "string" ? { credential: value.credential } : {}),
    devices,
    push,
  };
}

export class MobileAccessStore implements DeviceCredentialStore {
  private readonly path: string;
  private state: MobileAccessFile | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly encryption: EncryptionPort;
  private readonly log: (level: "warn", message: string, data?: Record<string, unknown>) => void;

  constructor(
    dataDir: string,
    encryption: EncryptionPort,
    log: (level: "warn", message: string, data?: Record<string, unknown>) => void = () => undefined,
  ) {
    this.path = join(dataDir, "mobile-access.json");
    this.encryption = encryption;
    this.log = log;
  }

  private async load(): Promise<MobileAccessFile> {
    if (this.state) return this.state;
    let parsed: MobileAccessFile | null = null;
    try {
      parsed = sanitize(JSON.parse(await readFile(this.path, "utf8")));
      if (!parsed) this.log("warn", "mobile access file is invalid; starting disabled");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.log("warn", "mobile access file could not be read; starting disabled", { error: String(error) });
      }
    }
    // An unreadable file never re-enables anything: a fresh state is disabled.
    this.state = parsed ?? emptyFile();
    if (!parsed) await this.persist(this.state);
    return this.state;
  }

  private async persist(state: MobileAccessFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
  }

  private async mutate<T>(operation: (state: MobileAccessFile) => T): Promise<T> {
    let result!: T;
    const run = this.chain.then(async () => {
      const state = await this.load();
      result = operation(state);
      await this.persist(state);
    });
    this.chain = run.catch(() => undefined);
    await run;
    return result;
  }

  async config(): Promise<MobileAccessConfig> {
    const state = await this.load();
    return {
      enabled: state.enabled,
      hostId: state.hostId,
      ...(state.hostLabel ? { hostLabel: state.hostLabel } : {}),
      ...(state.relayOrigin ? { relayOrigin: state.relayOrigin } : {}),
      ...(state.relayId ? { relayId: state.relayId } : {}),
      enrolled: Boolean(state.relayOrigin && state.credential),
    };
  }

  encryptionAvailable(): boolean {
    return this.encryption.isAvailable();
  }

  async setEnrollment(input: { relayOrigin: string; relayId: string; credential: string; hostLabel: string }): Promise<void> {
    if (!this.encryption.isAvailable()) {
      throw Object.assign(new Error("secure storage is unavailable; the relay credential cannot be stored"), { errorCode: "ENCRYPTION_UNAVAILABLE" });
    }
    const encrypted = this.encryption.encryptString(input.credential).toString("base64");
    await this.mutate((state) => {
      state.relayOrigin = input.relayOrigin;
      state.relayId = input.relayId;
      state.credential = encrypted;
      state.hostLabel = input.hostLabel;
    });
  }

  /** Forget the relay: credential, origin, every phone, and every push registration. */
  async clearEnrollment(): Promise<void> {
    this.pairings.clear();
    await this.mutate((state) => {
      delete state.relayOrigin;
      delete state.relayId;
      delete state.credential;
      state.enabled = false;
      const now = new Date().toISOString();
      for (const device of state.devices) device.revokedAt ??= now;
      state.push = {};
    });
  }

  /** The decrypted link credential, or null when absent or undecryptable. */
  async credential(): Promise<string | null> {
    const state = await this.load();
    if (!state.credential) return null;
    try {
      return this.encryption.decryptString(Buffer.from(state.credential, "base64"));
    } catch (error) {
      this.log("warn", "mobile access credential could not be decrypted", { error: String(error) });
      return null;
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.mutate((state) => {
      state.enabled = enabled;
    });
  }

  async setPush(deviceId: string, registration: MobilePushRegistration | null): Promise<void> {
    await this.mutate((state) => {
      if (registration) state.push[deviceId] = registration;
      else delete state.push[deviceId];
    });
  }

  async pushDevices(): Promise<Record<string, MobilePushRegistration>> {
    return { ...(await this.load()).push };
  }

  // DeviceCredentialStore ----------------------------------------------------

  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
    const state = await this.load();
    return state.devices.find((device) => device.tokenHash === tokenHash) ?? null;
  }
  async saveDevice(record: DeviceRecord): Promise<void> {
    await this.mutate((state) => {
      state.devices = [...state.devices.filter((device) => device.deviceId !== record.deviceId), record];
    });
  }
  async touchDevice(deviceId: string, seenAt: string): Promise<void> {
    const state = await this.load();
    const device = state.devices.find((candidate) => candidate.deviceId === deviceId);
    // Informational; written with the next real mutation.
    if (device) device.lastSeenAt = seenAt;
  }
  async revokeDevice(deviceId: string, revokedAt: string): Promise<boolean> {
    return this.mutate((state) => {
      const device = state.devices.find((candidate) => candidate.deviceId === deviceId);
      if (!device || device.revokedAt) return false;
      device.revokedAt = revokedAt;
      delete state.push[deviceId];
      return true;
    });
  }
  async listDevices(): Promise<DeviceRecord[]> {
    return [...(await this.load()).devices];
  }
  async findPairing(tokenHash: string): Promise<PairingRecord | null> {
    return this.pairings.get(tokenHash) ?? null;
  }
  async savePairing(record: PairingRecord): Promise<void> {
    const now = Date.now();
    for (const [hash, pairing] of this.pairings) {
      if (pairing.consumedAt || Date.parse(pairing.expiresAt) <= now) this.pairings.delete(hash);
    }
    this.pairings.set(record.tokenHash, { ...record });
  }
  async consumePairing(tokenHash: string, consumedAt: string): Promise<boolean> {
    const pairing = this.pairings.get(tokenHash);
    if (!pairing || pairing.consumedAt) return false;
    pairing.consumedAt = consumedAt;
    return true;
  }
  async listPairings(): Promise<PairingRecord[]> {
    return [...this.pairings.values()].map((pairing) => ({ ...pairing }));
  }
}
