import type { RacpOperation } from "@pi-desktop/shared";

import type { ConnectionAuth } from "./auth.js";

/**
 * Operations a phone may never call, whatever its roles (profile §6). The
 * catalog's role rules already refuse most of them to `controller` +
 * `approver`; this list is the explicit, role-independent backstop so a
 * future role change cannot widen what a relayed connection reaches.
 */
export const MOBILE_FORBIDDEN_OPERATIONS: ReadonlySet<RacpOperation> = new Set<RacpOperation>([
  "session/archive",
  "session/delete",
  "session/revoke",
  "session/configure",
  "tools/advertise",
  "terminal/open",
  "terminal/input",
  "terminal/resize",
  "terminal/close",
  "project/register",
  "project/browse",
  "workspace/toolExecute",
  "workspace/toolAbort",
  "workspace/toolShell",
  "workspace/files",
  "attachment/create",
  "attachment/complete",
  "connection/pair",
]);

/** A pairing connection on the mobile profile may only pair (profile §5). */
const MOBILE_PAIRING_OPERATIONS: ReadonlySet<RacpOperation> = new Set<RacpOperation>(["connection/pair"]);

/**
 * Whether the access profile of a connection admits an operation. Connections
 * without a profile (the SSH-tunnel desktop) are unaffected.
 */
export function profileAllowsOperation(auth: ConnectionAuth, operation: RacpOperation): boolean {
  if (auth.profile !== "mobile") return true;
  if (auth.kind === "pairing") return MOBILE_PAIRING_OPERATIONS.has(operation);
  return !MOBILE_FORBIDDEN_OPERATIONS.has(operation);
}
