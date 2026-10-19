import type { MobileAccessPairing, MobileAccessStatus, MobileDeviceSummary } from "@pi-desktop/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";

export type MobileAccessAction = "enroll" | "toggle" | "pair" | "revoke" | "unenroll";

function errorCode(error: unknown): string {
  const code = (error as { errorCode?: unknown; code?: unknown } | null)?.errorCode ?? (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "UNKNOWN";
}

/**
 * Settings → Mobile access state. The pairing payload is held in component
 * state only and dropped on expiry or unmount; it is never logged, cached, or
 * persisted.
 */
export function useMobileAccess() {
  const [status, setStatus] = useState<MobileAccessStatus | null>(null);
  const [devices, setDevices] = useState<MobileDeviceSummary[]>([]);
  const [pairing, setPairing] = useState<MobileAccessPairing | null>(null);
  const [busy, setBusy] = useState<MobileAccessAction | null>(null);
  const [error, setError] = useState<{ action: MobileAccessAction | "load"; code: string } | null>(null);
  const mounted = useRef(true);
  const loadSeq = useRef(0);

  const refreshDevices = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const result = await api.mobileAccessListDevices();
      if (mounted.current && seq === loadSeq.current) setDevices(result.devices);
    } catch (cause) {
      if (mounted.current) setError({ action: "load", code: errorCode(cause) });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void api
      .mobileAccessStatus()
      .then((next) => {
        if (mounted.current) setStatus(next);
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError({ action: "load", code: errorCode(cause) });
      });
    void refreshDevices();
    const unsubscribe = api.onMobileAccessChanged((next) => {
      if (!mounted.current) return;
      setStatus(next);
      void refreshDevices();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [refreshDevices]);

  // Drop the QR code the moment it expires.
  useEffect(() => {
    if (!pairing) return;
    const remaining = Date.parse(pairing.expiresAt) - Date.now();
    const timer = window.setTimeout(() => setPairing(null), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [pairing]);

  const run = useCallback(async <T,>(action: MobileAccessAction, operation: () => Promise<T>): Promise<T | null> => {
    setBusy(action);
    setError(null);
    try {
      const result = await operation();
      return result;
    } catch (cause) {
      if (mounted.current) setError({ action, code: errorCode(cause) });
      return null;
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, []);

  return {
    status,
    devices,
    pairing,
    busy,
    error,
    enroll: async (relayOrigin: string, enrollmentCode: string, hostLabel: string) => {
      const next = await run("enroll", () => api.mobileAccessEnroll({ relayOrigin, enrollmentCode, ...(hostLabel.trim() ? { hostLabel } : {}) }));
      if (next && mounted.current) setStatus(next);
      return Boolean(next);
    },
    setEnabled: async (enabled: boolean) => {
      const next = await run("toggle", () => api.mobileAccessSetEnabled(enabled));
      if (next && mounted.current) {
        setStatus(next);
        if (!enabled) setPairing(null);
      }
    },
    createPairing: async () => {
      const next = await run("pair", () => api.mobileAccessCreatePairing());
      if (next && mounted.current) setPairing(next);
    },
    closePairing: () => setPairing(null),
    revoke: async (deviceId: string) => {
      const result = await run("revoke", () => api.mobileAccessRevokeDevice(deviceId));
      if (result) await refreshDevices();
    },
    unenroll: async () => {
      const next = await run("unenroll", () => api.mobileAccessUnenroll());
      if (next && mounted.current) {
        setStatus(next);
        setPairing(null);
        await refreshDevices();
      }
    },
  };
}
