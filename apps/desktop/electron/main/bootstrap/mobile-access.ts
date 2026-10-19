/**
 * Boot hook for Mobile access (D663 / ADR 0331). Startup creates the service
 * over the existing Agent Host bridge; IPC and shutdown read the singleton, so
 * no new field flows through `index.ts`.
 */
import { hostname } from "node:os";

import type { AgentHost } from "@pi-desktop/agent-host";
import type { HostRpc } from "@pi-desktop/host-runtime";
import { IPC } from "@pi-desktop/shared";

import { createMobileAccessService, type MobileAccessService } from "../mobile/mobile-access-service.js";
import type { EncryptionPort } from "../remote/remote-host-registry.js";

let activeMobileAccess: MobileAccessService | null = null;

export function getActiveMobileAccess(): MobileAccessService | null {
  return activeMobileAccess;
}

export function setActiveMobileAccess(service: MobileAccessService | null): void {
  activeMobileAccess = service;
}

export type BootMobileAccessOptions = {
  dataDir: string;
  encryption: EncryptionPort;
  agentHost: AgentHost;
  getHost: () => HostRpc | null;
  appVersion: string;
  sendToRenderer: (channel: string, payload: unknown) => void;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
};

/** Create and start the service; a failure is logged and leaves mobile access off. */
export function bootMobileAccess(options: BootMobileAccessOptions): MobileAccessService {
  const service = createMobileAccessService({
    dataDir: options.dataDir,
    encryption: options.encryption,
    agentHost: options.agentHost,
    getHost: options.getHost,
    appVersion: options.appVersion,
    defaultHostLabel: hostname().replace(/\.local$/, "") || "PI-Desktop",
    emitStatus: (status) => options.sendToRenderer(IPC.event.mobileAccessChanged, status),
    onSessionsChanged: () => options.sendToRenderer(IPC.event.sessionsChanged, { reason: "mobile.session.changed" }),
    log: options.log,
  });
  setActiveMobileAccess(service);
  service.start().catch((error: unknown) => {
    options.log("warn", "mobile access start failed", { error: String(error) });
  });
  return service;
}

/** Dispose the singleton on quit; closes the relay link and every phone connection. */
export async function shutdownMobileAccess(): Promise<void> {
  const service = activeMobileAccess;
  activeMobileAccess = null;
  await service?.dispose();
}
