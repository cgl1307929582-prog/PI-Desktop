import {
  PUSH_NOTIFICATION_KINDS,
  isPushNotification,
  pushTitle,
  type PushNotification,
  type PushNotificationKind,
  type RacpEventEnvelope,
} from "@pi-desktop/shared";

export type PushNotifierOptions = {
  hostId: string;
  /** Devices that registered an APNs token and are still active. */
  pushDevices: () => string[];
  /** True while that device has a live subscription to the session (app in the foreground). */
  isDeviceSubscribed: (deviceId: string, sessionId: string) => boolean;
  /** The session's current title, or undefined when unknown. */
  sessionTitle: (sessionId: string) => Promise<string | undefined>;
  send: (deviceIds: string[], notification: PushNotification) => boolean;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
};

const KINDS: ReadonlySet<string> = new Set(PUSH_NOTIFICATION_KINDS);

function stringField(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Rebuild the profile §7 payload from scratch for one durable event. Nothing
 * from the event payload is copied except the request id; prompts, model
 * output, tool names, arguments, and paths can therefore never leak, and the
 * schema check is a second fence.
 */
export function buildPushNotification(
  hostId: string,
  envelope: RacpEventEnvelope,
  title: string | undefined,
): PushNotification | null {
  if (!KINDS.has(envelope.kind) || envelope.scope !== "session" || !envelope.sessionId) return null;
  if (typeof envelope.sequence !== "number") return null;
  const kind = envelope.kind as PushNotificationKind;
  const requestId = kind === "approval.requested" || kind === "input.requested" ? stringField(envelope.payload, "id") : undefined;
  const notification: PushNotification = {
    kind,
    hostId,
    sessionId: envelope.sessionId,
    ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
    ...(requestId ? { requestId } : {}),
    title: pushTitle(title),
    ...(kind === "approval.requested" && stringField(envelope.payload, "kind") === "tool" ? { category: "APPROVAL" as const } : {}),
  };
  return isPushNotification(notification) ? notification : null;
}

/**
 * Feeds durable Agent Host events to the relay as redacted pushes. A device
 * that is currently subscribed to the session is skipped: its app is open and
 * already shows the event.
 */
export function createPushNotifier(options: PushNotifierOptions): { handle(envelope: RacpEventEnvelope): Promise<void> } {
  return {
    async handle(envelope) {
      if (!KINDS.has(envelope.kind) || !envelope.sessionId || typeof envelope.sequence !== "number") return;
      const sessionId = envelope.sessionId;
      const targets = options.pushDevices().filter((deviceId) => !options.isDeviceSubscribed(deviceId, sessionId));
      if (targets.length === 0) return;
      let title: string | undefined;
      try {
        title = await options.sessionTitle(sessionId);
      } catch (error) {
        options.log("warn", "push title lookup failed", { sessionId, error: String(error) });
      }
      const notification = buildPushNotification(options.hostId, envelope, title);
      if (!notification) return;
      if (!options.send(targets, notification)) {
        options.log("info", "push skipped: host link is down", { kind: notification.kind });
      }
    },
  };
}
