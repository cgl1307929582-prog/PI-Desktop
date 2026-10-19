import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";

import {
  MobileAccessInputError,
  buildMobilePairingPayload,
  normalizeRelayOrigin,
  parseMobilePairingPayload,
} from "./mobile-access.js";
import { RACP_OPERATIONS, rolesAllowOperation } from "./racp.js";
import {
  PushNotificationSchema,
  RACP_HOSTLINK_PROTOCOL,
  RacpPushRegisterParamsSchema,
  isPushNotification,
  parseHostLinkHostFrame,
  parseHostLinkRelayFrame,
  pushTitle,
  relayClientPath,
} from "./racp-hostlink.js";

const link = RACP_HOSTLINK_PROTOCOL;
const hash = "a".repeat(64);
const route = {
  hostId: "host_1",
  clientConnectionId: "c1",
  presentedToken: "pdt1.abc",
  remoteAddress: "203.0.113.4",
  openedAt: "2026-10-17T00:00:00.000Z",
};

describe("racp-hostlink.v1 relay → host frames", () => {
  it.each([
    { link, type: "client.open", clientConnectionId: "c1", routeContext: route },
    { link, type: "client.message", clientConnectionId: "c1", message: '{"jsonrpc":"2.0","id":1,"method":"connection/ping"}' },
    { link, type: "client.close", clientConnectionId: "c1", reason: "phone closed" },
    { link, type: "push.result", deviceId: "dev_1", status: "invalid-token" },
    { link, type: "link.pong", at: 1 },
  ])("accepts $type", (frame) => {
    expect(parseHostLinkRelayFrame(JSON.stringify(frame))).toEqual(frame);
    expect(parseHostLinkHostFrame(JSON.stringify(frame))).toBeNull();
  });

  it("refuses unknown fields, a wrong link name, non-JSON and a message that is not a string", () => {
    expect(parseHostLinkRelayFrame(JSON.stringify({ link, type: "client.close", clientConnectionId: "c1", reason: "x", extra: 1 }))).toBeNull();
    expect(parseHostLinkRelayFrame(JSON.stringify({ link: "racp-hostlink.v2", type: "link.pong" }))).toBeNull();
    expect(parseHostLinkRelayFrame("not json")).toBeNull();
    expect(parseHostLinkRelayFrame(JSON.stringify({ link, type: "client.message", clientConnectionId: "c1", message: { id: 1 } }))).toBeNull();
    expect(parseHostLinkRelayFrame(JSON.stringify({ link, type: "client.open", clientConnectionId: "c1", routeContext: { ...route, extra: true } }))).toBeNull();
  });

  it("refuses a frame larger than the link bound", () => {
    const huge = JSON.stringify({ link, type: "client.message", clientConnectionId: "c1", message: "x".repeat(1024 * 1024) });
    expect(parseHostLinkRelayFrame(huge)).toBeNull();
  });
});

describe("racp-hostlink.v1 host → relay frames", () => {
  const notification = { kind: "approval.requested", hostId: "host_1", sessionId: "s1", requestId: "ap_1", title: "Fix tests", category: "APPROVAL" };
  it.each([
    { link, type: "host.message", clientConnectionId: "c1", message: "{}" },
    { link, type: "host.close", clientConnectionId: "c1", code: "REMOTE_AUTH_FAILED" },
    { link, type: "host.devices", tokenHashes: [hash], pairingHashes: [] },
    { link, type: "push.register", deviceId: "dev_1", apnsToken: "ab".repeat(32), environment: "sandbox" },
    { link, type: "push.unregister", deviceId: "dev_1" },
    { link, type: "push.notify", deviceIds: ["dev_1"], notification },
    { link, type: "link.ping", at: 5 },
  ])("accepts $type", (frame) => {
    expect(parseHostLinkHostFrame(JSON.stringify(frame))).toEqual(frame);
    expect(parseHostLinkRelayFrame(JSON.stringify(frame))).toBeNull();
  });

  it("refuses device hashes that are not SHA-256 hex and an empty push target list", () => {
    expect(parseHostLinkHostFrame(JSON.stringify({ link, type: "host.devices", tokenHashes: ["pdt1.raw"], pairingHashes: [] }))).toBeNull();
    expect(parseHostLinkHostFrame(JSON.stringify({ link, type: "push.notify", deviceIds: [], notification }))).toBeNull();
  });
});

describe("push payload whitelist", () => {
  const base = { kind: "turn.completed", hostId: "h", sessionId: "s1", turnId: "t1", title: "Session" };
  it("accepts the four kinds and only the profile §7 fields", () => {
    for (const kind of ["turn.completed", "turn.failed", "approval.requested", "input.requested"]) {
      expect(isPushNotification({ ...base, kind })).toBe(true);
    }
    expect(isPushNotification({ ...base, kind: "item.delta" })).toBe(false);
    expect(isPushNotification({ ...base, prompt: "secret prompt" })).toBe(false);
    expect(isPushNotification({ ...base, toolName: "Bash" })).toBe(false);
    expect(isPushNotification({ ...base, title: "x".repeat(81) })).toBe(false);
    expect(Value.Check(PushNotificationSchema, { ...base, category: "OTHER" })).toBe(false);
  });

  it("truncates titles to 80 characters without splitting a character", () => {
    expect(pushTitle("  a  b ")).toBe("a b");
    const long = pushTitle("界".repeat(100));
    expect(Array.from(long)).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
    expect(pushTitle(undefined)).toBe("");
  });

  it("validates push/register params and grants it to controllers only", () => {
    expect(Value.Check(RacpPushRegisterParamsSchema, { apnsToken: "0f".repeat(32), environment: "production" })).toBe(true);
    expect(Value.Check(RacpPushRegisterParamsSchema, { apnsToken: "not-hex", environment: "production" })).toBe(false);
    expect(Value.Check(RacpPushRegisterParamsSchema, { apnsToken: "0f".repeat(32), environment: "dev" })).toBe(false);
    expect(RACP_OPERATIONS["push/register"]).toEqual({ role: "controller", profile: "remote-host", mutation: true });
    expect(rolesAllowOperation(["controller", "approver"], "push/register")).toBe(true);
    expect(rolesAllowOperation(["viewer"], "push/register")).toBe(false);
  });

  it("encodes the host id in the phone path", () => {
    expect(relayClientPath("host/1")).toBe("/v1/hosts/host%2F1/racp");
  });
});

describe("mobile access pairing payload", () => {
  it("normalizes https origins and refuses anything else", () => {
    expect(normalizeRelayOrigin(" https://relay.example.com/ ")).toBe("https://relay.example.com");
    expect(normalizeRelayOrigin("https://relay.example.com:8443")).toBe("https://relay.example.com:8443");
    for (const bad of ["http://relay.example.com", "https://u:p@relay.example.com", "https://relay.example.com/x", "https://relay.example.com/?t=1", "relay", "wss://relay.example.com"]) {
      expect(() => normalizeRelayOrigin(bad)).toThrow(MobileAccessInputError);
    }
  });

  it("round-trips the QR payload and refuses invalid ones", () => {
    const raw = buildMobilePairingPayload({ relay: "https://relay.example.com/", hostId: "host_1", pairingToken: "ppt1.xyz", hostLabel: "Mac" });
    expect(JSON.parse(raw)).toEqual({ v: 1, relay: "https://relay.example.com", hostId: "host_1", pairingToken: "ppt1.xyz", hostLabel: "Mac" });
    expect(parseMobilePairingPayload(raw)?.pairingToken).toBe("ppt1.xyz");
    expect(parseMobilePairingPayload(raw.replace("ppt1.", "pdt1."))).toBeNull();
    expect(parseMobilePairingPayload(raw.replace("https://", "http://"))).toBeNull();
    expect(parseMobilePairingPayload(JSON.stringify({ ...JSON.parse(raw), v: 2 }))).toBeNull();
    expect(parseMobilePairingPayload("{")).toBeNull();
  });
});
