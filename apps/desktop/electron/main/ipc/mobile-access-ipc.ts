/**
 * Renderer IPC for Settings → Mobile access (D663 / ADR 0331). Status and the
 * device list never carry a credential or hash; `createPairing` returns the QR
 * payload once and Main never logs it.
 */
import {
  ErrorCodes,
  IPC,
  type MobileAccessEnrollRequest,
  type MobileAccessPairing,
  type MobileAccessRevokeRequest,
  type MobileAccessSetEnabledRequest,
  type MobileAccessStatus,
  type MobileDeviceSummary,
} from "@pi-desktop/shared";

import { getActiveMobileAccess } from "../bootstrap/mobile-access.js";
import type { MobileAccessService } from "../mobile/mobile-access-service.js";
import type { IpcRegistrar } from "./types";

export type RegisterMobileAccessIpcOptions = {
  registrar: Pick<IpcRegistrar, "handle">;
  getService?: () => MobileAccessService | null;
};

function requireService(service: MobileAccessService | null): MobileAccessService {
  if (!service) {
    throw Object.assign(new Error("mobile access is not ready yet"), { errorCode: ErrorCodes.AGENT_UNAVAILABLE });
  }
  return service;
}

function invalid(message: string, field: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT, field });
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw invalid(`${field} is required`, field);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw invalid(`${field} is invalid`, field);
  return trimmed;
}

export function registerMobileAccessIpc(options: RegisterMobileAccessIpcOptions): void {
  const { registrar } = options;
  const service = () => requireService((options.getService ?? getActiveMobileAccess)());

  registrar.handle(IPC.invoke.mobileAccessStatus, async (): Promise<MobileAccessStatus> => service().status());

  registrar.handle(IPC.invoke.mobileAccessEnroll, async (request: MobileAccessEnrollRequest): Promise<MobileAccessStatus> => {
    const relayOrigin = text(request?.relayOrigin, "relayOrigin", 300);
    const enrollmentCode = text(request?.enrollmentCode, "enrollmentCode", 200);
    const hostLabel = typeof request?.hostLabel === "string" ? request.hostLabel.trim().slice(0, 80) : undefined;
    return service().enroll({ relayOrigin, enrollmentCode, ...(hostLabel ? { hostLabel } : {}) });
  });

  registrar.handle(IPC.invoke.mobileAccessUnenroll, async (): Promise<MobileAccessStatus> => service().unenroll());

  registrar.handle(IPC.invoke.mobileAccessSetEnabled, async (request: MobileAccessSetEnabledRequest): Promise<MobileAccessStatus> => {
    if (typeof request?.enabled !== "boolean") throw invalid("enabled must be a boolean", "enabled");
    return service().setEnabled(request.enabled);
  });

  registrar.handle(IPC.invoke.mobileAccessCreatePairing, async (): Promise<MobileAccessPairing> => service().createPairing());

  registrar.handle(IPC.invoke.mobileAccessListDevices, async (): Promise<{ devices: MobileDeviceSummary[] }> => ({
    devices: await service().listDevices(),
  }));

  registrar.handle(IPC.invoke.mobileAccessRevokeDevice, async (request: MobileAccessRevokeRequest): Promise<{ revoked: boolean }> => ({
    revoked: await service().revokeDevice(text(request?.deviceId, "deviceId", 200)),
  }));
}
