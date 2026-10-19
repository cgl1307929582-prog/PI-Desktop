/**
 * Relay enrollment (profile §3): exchange a one-time `pre1.` code for the
 * per-Host `prh1.` link credential. HTTPS only, no redirects followed, and
 * the response must come from the pinned origin, so neither the code nor the
 * credential can be steered to another server.
 */
import {
  RACP_RELAY_ENROLLMENT_PREFIX,
  RACP_RELAY_HOST_CREDENTIAL_PREFIX,
  RACP_RELAY_PATHS,
  normalizeRelayOrigin,
} from "@pi-desktop/shared";

export type EnrollmentResult = { credential: string; relayId: string };

export type EnrollmentFetch = (url: string, init: RequestInit) => Promise<Response>;

function enrollmentError(message: string, errorCode: string, field?: string): Error & { errorCode: string; field?: string } {
  return Object.assign(new Error(message), { errorCode, ...(field ? { field } : {}) });
}

export async function enrollWithRelay(input: {
  relayOrigin: string;
  enrollmentCode: string;
  hostId: string;
  hostLabel: string;
  fetch?: EnrollmentFetch;
  timeoutMs?: number;
}): Promise<EnrollmentResult & { relayOrigin: string }> {
  const origin = normalizeRelayOrigin(input.relayOrigin);
  const code = input.enrollmentCode.trim();
  if (!code.startsWith(RACP_RELAY_ENROLLMENT_PREFIX) || code.length > 200 || /\s/.test(code)) {
    throw enrollmentError("the enrollment code is not a relay enrollment code", "INVALID_ARGUMENT", "enrollmentCode");
  }
  const url = `${origin}${RACP_RELAY_PATHS.enroll}`;
  const doFetch = input.fetch ?? ((target, init) => fetch(target, init));
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ code, hostId: input.hostId, label: input.hostLabel }),
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
    });
  } catch (error) {
    throw enrollmentError(`the relay could not be reached: ${error instanceof Error ? error.message : String(error)}`, "REMOTE_CONNECTION_FAILED");
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw enrollmentError("the relay answered with a redirect, which is refused", "REMOTE_CONNECTION_FAILED");
  }
  if (response.url && new URL(response.url).origin !== origin) {
    throw enrollmentError("the relay answered from a different origin", "REMOTE_CONNECTION_FAILED");
  }
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 410) {
    throw enrollmentError("the relay refused the enrollment code (wrong, used, or expired)", "PAIRING_FAILED", "enrollmentCode");
  }
  if (!response.ok) throw enrollmentError(`the relay answered ${response.status}`, "REMOTE_CONNECTION_FAILED");
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw enrollmentError("the relay answer is not JSON", "REMOTE_CONNECTION_FAILED");
  }
  const record = body as { credential?: unknown; relayId?: unknown } | null;
  const credential = typeof record?.credential === "string" ? record.credential : "";
  const relayId = typeof record?.relayId === "string" ? record.relayId : "";
  if (!credential.startsWith(RACP_RELAY_HOST_CREDENTIAL_PREFIX) || credential.length > 512 || !relayId) {
    throw enrollmentError("the relay answer has no valid credential", "REMOTE_CONNECTION_FAILED");
  }
  return { credential, relayId, relayOrigin: origin };
}
