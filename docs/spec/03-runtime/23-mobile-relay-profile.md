# Mobile Relay Profile (`racp-hostlink.v1` over a self-hosted relay)

- Status: Draft for rollout R4 (D663 / ADR 0331)
- Applies to: PI-Desktop (Agent Host side), `pi-relay` (self-hosted relay),
  `pi-mobile-ios` (client)
- Base contracts: `19-remote-agent-control-protocol.md` (RACP v1, §11.4 Host
  link), `05-security/02-remote-control-security.md`

This document makes the reserved Host link concrete for one topology: a single
user's desktop, that user's relay server, and that user's iPhone. Every RACP
rule of document 19 applies unchanged to each logical client connection.

## 1. Components and trust

```text
iPhone (pi-mobile-ios) ──WSS──▶ pi-relay (user's server) ◀──WSS── PI-Desktop
       RACP-WS header profile        routes frames            Host link (outbound)
```

| Component | Holds | Never holds |
|---|---|---|
| Desktop (Agent Host) | Sessions, transcripts, provider secrets, device-token hashes, relay link credential | APNs key |
| Relay | Host link credential hashes, mirrored device-token hashes, APNs key, phone APNs tokens | Provider secrets, transcripts, prompts (except transiently in memory) |
| Phone | `pdt1.` device token (Keychain), relay URL, Host id, cached UI state | Provider secrets, link credential |

The relay is operated by the desktop owner (D385). TLS terminates at the
relay; the relay MUST NOT persist or log RACP payloads, tokens, or
`Authorization` headers.

## 2. Relay endpoints

All endpoints are TLS only. Plain HTTP and `ws://` are refused.

| Endpoint | Caller | Auth | Purpose |
|---|---|---|---|
| `POST /v1/hosts/enroll` | Desktop | One-time enrollment code in body | Exchange for a Host link credential |
| `GET /v1/hostlink` (WebSocket, subprotocol `racp-hostlink.v1`) | Desktop | `Authorization: Bearer prh1.…` | The multiplexed Host link |
| `GET /v1/hosts/{hostId}/racp` (WebSocket, subprotocol `pi-racp.v1.jsonrpc`, the RACP-WS subprotocol) | Phone | `Authorization: Bearer pdt1.…` or `ppt1.…` | One logical RACP connection |
| `GET /healthz` | Operator | None | Liveness only; reveals no Host state |

Tokens never appear in a URL; an upgrade with any query string is refused.
`hostId` in the path is a routing key, not a credential. Behind a TLS proxy the
relay requires `X-Forwarded-Proto: https` and answers `403` otherwise.

## 3. Relay enrollment of a desktop

1. The operator runs `pi-relay host enroll --label <name>` on the server. It
   prints a one-time code `pre1.<random>` valid for 10 minutes.
2. In desktop **Settings → Mobile access**, the user enters the relay origin
   (`https://…`) and the code. The desktop calls `POST /v1/hosts/enroll` with
   `{ code, hostId, label }`.
3. The relay consumes the code, stores `{ hostId, credentialHash }`, and returns
   `{ credential: "prh1.<random>", relayId }`. A second use of the code fails
   with `PAIRING_TOKEN_EXPIRED`.
4. The desktop stores the credential with the same OS-keychain encryption as
   remote-host device tokens and pins the relay origin. A later redirect to a
   different origin is refused.
5. `pi-relay host revoke <hostId>` deletes the credential and closes the link.

## 4. Host link frames

The link uses the frame union of document 19 §11.4 with these additions and
clarifications. Every frame carries `link: "racp-hostlink.v1"`.

```ts
type RelayRouteContext = {
  hostId: string
  clientConnectionId: string // relay-assigned, unique per link
  presentedToken: string     // the client's bearer, forwarded verbatim
  remoteAddress: string      // for audit only
  openedAt: string
}

type HostLinkAdditions =
  | { type: "client.open"; clientConnectionId: string; routeContext: RelayRouteContext }
  | { type: "host.devices"; tokenHashes: string[]; pairingHashes: string[] }
  | { type: "push.register"; deviceId: string; apnsToken: string; environment: "sandbox" | "production" }
  | { type: "push.unregister"; deviceId: string }
  | { type: "push.notify"; deviceIds: string[]; notification: PushNotification }
  | { type: "push.result"; deviceId: string; status: "sent" | "invalid-token" | "failed" }
```

Rules:

1. **Authentication is the Host's.** On `client.open` the desktop hashes
   `presentedToken` and resolves it with its `DeviceCredentialStore` exactly as
   the loopback binding does (`packages/racp/src/auth.ts`). A pairing token
   authenticates an unprivileged connection that may only call
   `connection/pair`. Failure ends the logical connection with `host.close`
   code `REMOTE_AUTH_FAILED`. This route context replaces the Gateway-signed
   `HostRouteContext` of security §3.3 for this profile.
2. **Relay pre-filter.** After every pairing, revocation, and link start, the
   desktop sends `host.devices` with the SHA-256 hashes of active device
   tokens and unexpired pairing tokens. The relay refuses an upgrade whose
   bearer hash is absent (HTTP 401) before sending `client.open`. The
   pre-filter is defense in depth, not authority. When a mirror update drops
   the hash of a connected **device** token, the relay closes that phone
   (`4001 REVOKED`). It does not close a **pairing** connection: its hash
   leaves the mirror the moment pairing succeeds, possibly before the
   desktop's `connection/pair` answer is relayed, and the desktop already keeps
   that connection pair-only.
3. **Isolation.** Each logical connection gets its own `RacpConnection` via
   `RacpServer.accept(auth, transport)`: its own `connection/initialize`,
   subscriptions, server-request ids, and send queue (§11.4 rule 2).
4. **Opacity.** The relay forwards `message` byte-for-byte; it MUST NOT
   renumber, reorder, coalesce, or re-key it (§11.4 rule 3).
5. **Liveness.** `link.ping` every 30 seconds from the desktop; the relay
   answers `link.pong`. Two missed pongs end the link. On link loss the relay
   closes every phone socket with close code 1012 and the phone resumes from
   its durable cursor after the desktop reconnects.
6. **Reconnect.** The desktop reconnects with exponential backoff from 1 s to
   60 s with jitter. A second concurrent link for the same `hostId` replaces
   the first; the relay closes the older link.
7. **Binary frames.** None in R4. Attachments remain
   `CAPABILITY_UNAVAILABLE` until their own change; `attachment.chunk` keeps
   its §11.4 meaning when scheduled.

## 5. Phone pairing

1. In **Settings → Mobile access → Pair a phone**, the desktop mints a
   pairing token (`ppt1.`, single use, 5 minute expiry), sends the updated
   `host.devices`, and renders a QR code with:

   ```json
   { "v": 1, "relay": "https://relay.example.com", "hostId": "…", "pairingToken": "ppt1.…", "hostLabel": "My Mac" }
   ```

   The QR code is displayed only on the desktop screen (out of band, security
   §3.1). It is never logged, copied to the clipboard, or written to disk; the
   desktop keeps pairing-token hashes in memory only, so a restart invalidates
   an unused code.
2. The phone connects to `/v1/hosts/{hostId}/racp` with the pairing token as
   bearer and calls `connection/pair` with `{ label: <device name> }`.
3. The desktop mints a `pdt1.` device token with roles
   `["controller", "approver"]`, records the device, consumes the pairing
   token, and pushes `host.devices`. The phone stores the device token in the
   Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) and reconnects
   with it.
4. The desktop shows the new device in the device list with label, created and
   last-seen times, and a **Revoke** action. Revocation closes that device's
   logical connections and removes its hash from the relay mirror.

## 6. Permissions for a phone principal

- Roles `controller` + `approver`; never `owner`.
- Turns run under the remote permission ceiling (security §4.3, default
  `ask`); `applyCeilingToPairedDevices` does not exempt phones because they are
  not SSH-bootstrapped.
- `allowedDecisions` for tool approvals contain `allow-once` and `deny`;
  `allow-session` only when Host policy enables remote session grants.
- Plan/Goal approval with a permission mode: refused by default.
- `session/archive`, `session/delete`, `session/configure`, `session/revoke`,
  `terminal/*`, `tools/advertise`, `project/register`, `project/browse`,
  `workspace/tool*`, `workspace/files`, `attachment/*`: refused with
  `FORBIDDEN` by the mobile policy (`packages/racp/src/mobile-policy.ts`),
  whatever the roles. A pairing connection may call only `connection/pair`.
- A phone credential authenticates only on the mobile profile, and an SSH
  bootstrap credential never does (`DeviceRecord.profile`).

## 7. Push notifications

1. After pairing, the phone calls the RACP operation `push/register`
   `{ apnsToken, environment }` (a remote-host profile addition, owner of the
   device only). The desktop forwards `push.register` to the relay; the desktop
   stores only that the device has push enabled.
2. The desktop sends `push.notify` on durable `turn.completed`, `turn.failed`,
   `approval.requested`, and `input.requested` events for sessions in projects
   the device may see, unless a logical connection of that device is currently
   subscribed to the session (the app is in the foreground).

   ```ts
   type PushNotification = {
     kind: "turn.completed" | "turn.failed" | "approval.requested" | "input.requested"
     hostId: string
     sessionId: string
     turnId?: string
     requestId?: string
     title: string        // session title, truncated to 80 characters
     category?: "APPROVAL" // enables the iOS approve / deny actions
   }
   ```

   Payloads never contain prompts, model output, tool names or arguments, file
   paths, or secrets.
3. The relay sends through APNs with token-based (`.p8`) authentication and
   reports `push.result`; `invalid-token` makes the desktop drop the
   registration. The alert text is a localization key (`PUSH_TURN_COMPLETED`,
   `PUSH_TURN_FAILED`, `PUSH_APPROVAL_REQUESTED`, `PUSH_INPUT_REQUESTED`) shipped
   in the app; the relay composes no user-visible text and adds only the ids
   under `pi`. Revoking a phone sends `push.unregister`.
4. An approve/deny action from a notification opens a short-lived connection
   and calls `approval/respond`; it never bypasses the RACP approval path.

## 8. Limits

Document 19 §12 applies per logical connection. Relay-level additions:

| Limit | Target |
|---|---:|
| Logical phone connections per Host | 8 |
| Upgrade attempts per remote address | 30 / minute |
| Failed authentication per remote address | 10 / 10 minutes, then 15 minute block |
| Host link frame | 1 MiB |
| Enrollment code lifetime | 10 minutes |
| Pairing token lifetime | 5 minutes |
| Push notifications per Host | 60 / minute |

## 9. Versioning

- The JSON Schema fixture generated from `packages/shared` is the contract
  for all three repositories; `pi-relay` and `pi-mobile-ios` pin a fixture
  version.
- `connection/initialize` reports the RACP protocol version; the phone refuses
  a Host it does not support with a visible "update required" state.
- The Host link subprotocol is versioned in its name; a breaking change ships
  as `racp-hostlink.v2` alongside v1 for at least one desktop release.

## 10. Conformance

Implemented in `packages/racp/src/{mobile-auth,hostlink,hostlink-push}.test.ts`,
`packages/agent-host/src/mobile-policy.test.ts`,
`apps/desktop/test/mobile-access-*.test.mjs`, and in the `pi-relay` repository
(`test/websocket.integration.test.ts`, and `test/desktop.integration.test.ts`,
which runs this repository's Host link against the real relay).

- Pairing token single use and expiry; device token revocation closes live
  connections.
- Relay refuses unknown bearer hashes before `client.open`.
- Two phones on one link do not see each other's server requests.
- Link loss: running turn continues on the desktop; phone resubscribes with
  `after` and receives replay or a snapshot with `resyncReason`.
- Phone principal cannot exceed the ceiling, archive, or open a terminal.
- Push payloads contain only the fields of §7.
- Relay logs contain no `Authorization` header, token, or `message` body.
