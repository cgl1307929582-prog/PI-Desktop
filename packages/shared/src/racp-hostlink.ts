/**
 * `racp-hostlink.v1`: the outbound link from a desktop Agent Host to a
 * user-self-hosted relay (D663 / ADR 0331).
 *
 * Normative source: `docs/spec/03-runtime/23-mobile-relay-profile.md` §4 and
 * `19-remote-agent-control-protocol.md` §11.4. The relay multiplexes phone
 * connections onto one authenticated WebSocket. Every RACP rule applies per
 * logical connection; the relay forwards `message` strings byte-for-byte and
 * never interprets them.
 */
import Type from "typebox";
import * as Value from "typebox/value";

type Static<T extends Type.TSchema> = Type.Static<T>;

/** WebSocket subprotocol of the Host link and the `link` field of every frame. */
export const RACP_HOSTLINK_PROTOCOL = "racp-hostlink.v1" as const;

/** One-time relay enrollment code printed by the relay operator CLI. */
export const RACP_RELAY_ENROLLMENT_PREFIX = "pre1." as const;
/** Per-Host relay link credential minted at enrollment. */
export const RACP_RELAY_HOST_CREDENTIAL_PREFIX = "prh1." as const;

/** Relay HTTP and WebSocket paths (profile §2). */
export const RACP_RELAY_PATHS = {
  enroll: "/v1/hosts/enroll",
  hostLink: "/v1/hostlink",
  /** `{hostId}` is a routing key, never a credential. */
  client: "/v1/hosts/{hostId}/racp",
  health: "/healthz",
} as const;

export function relayClientPath(hostId: string): string {
  return RACP_RELAY_PATHS.client.replace("{hostId}", encodeURIComponent(hostId));
}

/** Bounds of the profile (§8). */
export const RACP_HOSTLINK_LIMITS = {
  maxFrameBytes: 1024 * 1024,
  maxPhoneConnectionsPerHost: 8,
  pingIntervalMs: 30_000,
  maxMissedPongs: 2,
  reconnectBaseDelayMs: 1_000,
  reconnectMaxDelayMs: 60_000,
  enrollmentCodeLifetimeMs: 10 * 60 * 1000,
  pairingTokenLifetimeMs: 5 * 60 * 1000,
  pushPerHostPerMinute: 60,
  pushTitleMaxLength: 80,
} as const;

const Id = Type.String({ minLength: 1, maxLength: 200 });
const Sha256Hex = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Link = Type.Literal(RACP_HOSTLINK_PROTOCOL);

/**
 * What the relay learned about one phone connection. `presentedToken` is the
 * bearer forwarded verbatim; the desktop authenticates it itself (§4 rule 1).
 */
export const RelayRouteContextSchema = Type.Object(
  {
    hostId: Id,
    clientConnectionId: Id,
    presentedToken: Type.String({ minLength: 1, maxLength: 512 }),
    remoteAddress: Type.String({ maxLength: 200 }),
    openedAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type RelayRouteContext = Static<typeof RelayRouteContextSchema>;

export const PUSH_NOTIFICATION_KINDS = ["turn.completed", "turn.failed", "approval.requested", "input.requested"] as const;
export type PushNotificationKind = (typeof PUSH_NOTIFICATION_KINDS)[number];

/**
 * The only push payload the desktop may emit (§7). Prompts, model output,
 * tool names or arguments, file paths, and secrets are never part of it;
 * `additionalProperties: false` makes any extra field a schema violation.
 */
export const PushNotificationSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("turn.completed"),
      Type.Literal("turn.failed"),
      Type.Literal("approval.requested"),
      Type.Literal("input.requested"),
    ]),
    hostId: Id,
    sessionId: Id,
    turnId: Type.Optional(Id),
    requestId: Type.Optional(Id),
    title: Type.String({ maxLength: RACP_HOSTLINK_LIMITS.pushTitleMaxLength }),
    category: Type.Optional(Type.Literal("APPROVAL")),
  },
  { additionalProperties: false },
);
export type PushNotification = Static<typeof PushNotificationSchema>;

export const PushEnvironmentSchema = Type.Union([Type.Literal("sandbox"), Type.Literal("production")]);
export type PushEnvironment = Static<typeof PushEnvironmentSchema>;

/** APNs device tokens are hex; bound the length so the field cannot carry anything else. */
const ApnsToken = Type.String({ pattern: "^[0-9a-fA-F]{32,200}$" });

/** Params of the RACP `push/register` operation (remote-host profile). */
export const RacpPushRegisterParamsSchema = Type.Object(
  { apnsToken: ApnsToken, environment: PushEnvironmentSchema },
  { additionalProperties: false },
);
export type RacpPushRegisterParams = Static<typeof RacpPushRegisterParamsSchema>;

// Relay → desktop
export const HostLinkClientOpenSchema = Type.Object(
  { link: Link, type: Type.Literal("client.open"), clientConnectionId: Id, routeContext: RelayRouteContextSchema },
  { additionalProperties: false },
);
export const HostLinkClientMessageSchema = Type.Object(
  { link: Link, type: Type.Literal("client.message"), clientConnectionId: Id, message: Type.String() },
  { additionalProperties: false },
);
export const HostLinkClientCloseSchema = Type.Object(
  { link: Link, type: Type.Literal("client.close"), clientConnectionId: Id, reason: Type.String({ maxLength: 200 }) },
  { additionalProperties: false },
);
export const HostLinkPushResultSchema = Type.Object(
  {
    link: Link,
    type: Type.Literal("push.result"),
    deviceId: Id,
    status: Type.Union([Type.Literal("sent"), Type.Literal("invalid-token"), Type.Literal("failed")]),
  },
  { additionalProperties: false },
);
export const HostLinkPongSchema = Type.Object(
  { link: Link, type: Type.Literal("link.pong"), at: Type.Optional(Type.Number()) },
  { additionalProperties: false },
);

// Desktop → relay
export const HostLinkHostMessageSchema = Type.Object(
  { link: Link, type: Type.Literal("host.message"), clientConnectionId: Id, message: Type.String() },
  { additionalProperties: false },
);
export const HostLinkHostCloseSchema = Type.Object(
  { link: Link, type: Type.Literal("host.close"), clientConnectionId: Id, code: Type.String({ minLength: 1, maxLength: 64 }) },
  { additionalProperties: false },
);
export const HostLinkHostDevicesSchema = Type.Object(
  {
    link: Link,
    type: Type.Literal("host.devices"),
    tokenHashes: Type.Array(Sha256Hex, { maxItems: 1000 }),
    pairingHashes: Type.Array(Sha256Hex, { maxItems: 100 }),
  },
  { additionalProperties: false },
);
export const HostLinkPushRegisterSchema = Type.Object(
  { link: Link, type: Type.Literal("push.register"), deviceId: Id, apnsToken: ApnsToken, environment: PushEnvironmentSchema },
  { additionalProperties: false },
);
export const HostLinkPushUnregisterSchema = Type.Object(
  { link: Link, type: Type.Literal("push.unregister"), deviceId: Id },
  { additionalProperties: false },
);
export const HostLinkPushNotifySchema = Type.Object(
  { link: Link, type: Type.Literal("push.notify"), deviceIds: Type.Array(Id, { minItems: 1, maxItems: 100 }), notification: PushNotificationSchema },
  { additionalProperties: false },
);
export const HostLinkPingSchema = Type.Object(
  { link: Link, type: Type.Literal("link.ping"), at: Type.Optional(Type.Number()) },
  { additionalProperties: false },
);

export const HostLinkRelayFrameSchema = Type.Union([
  HostLinkClientOpenSchema,
  HostLinkClientMessageSchema,
  HostLinkClientCloseSchema,
  HostLinkPushResultSchema,
  HostLinkPongSchema,
]);
export type HostLinkRelayFrame = Static<typeof HostLinkRelayFrameSchema>;

export const HostLinkHostFrameSchema = Type.Union([
  HostLinkHostMessageSchema,
  HostLinkHostCloseSchema,
  HostLinkHostDevicesSchema,
  HostLinkPushRegisterSchema,
  HostLinkPushUnregisterSchema,
  HostLinkPushNotifySchema,
  HostLinkPingSchema,
]);
export type HostLinkHostFrame = Static<typeof HostLinkHostFrameSchema>;

export type HostLinkFrame = HostLinkRelayFrame | HostLinkHostFrame;

function parseWith<T extends Type.TSchema>(schema: T, raw: string): Static<T> | null {
  if (raw.length > RACP_HOSTLINK_LIMITS.maxFrameBytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return Value.Check(schema, value) ? value : null;
}

/** A frame the relay sent to the desktop, or `null` when it is not one. */
export function parseHostLinkRelayFrame(raw: string): HostLinkRelayFrame | null {
  return parseWith(HostLinkRelayFrameSchema, raw);
}

/** A frame the desktop sent to the relay, or `null` when it is not one. */
export function parseHostLinkHostFrame(raw: string): HostLinkHostFrame | null {
  return parseWith(HostLinkHostFrameSchema, raw);
}

export function isPushNotification(value: unknown): value is PushNotification {
  return Value.Check(PushNotificationSchema, value);
}

/** Truncate a session title to the push bound without splitting a surrogate pair. */
export function pushTitle(title: string | undefined): string {
  const chars = Array.from((title ?? "").replace(/\s+/g, " ").trim());
  const max = RACP_HOSTLINK_LIMITS.pushTitleMaxLength;
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** The schemas the relay and the iOS client pin, generated into the fixture bundle. */
export const RACP_HOSTLINK_SCHEMAS = {
  RelayRouteContext: RelayRouteContextSchema,
  PushNotification: PushNotificationSchema,
  PushRegisterParams: RacpPushRegisterParamsSchema,
  HostLinkRelayFrame: HostLinkRelayFrameSchema,
  HostLinkHostFrame: HostLinkHostFrameSchema,
} as const;
