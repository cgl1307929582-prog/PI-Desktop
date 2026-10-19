# ADR 0331: iOS client controls the desktop Agent Host through a self-hosted relay

- Status: Accepted (rollout R4 implemented; device, APNs and Xcode app target unverified)
- Date: 2026-10-17
- Decision: D663
- Related: ADR 0205 (D373 / D374 / D375 / D385), ADR 0285 (D448),
  ADR 0286, `03-runtime/19-remote-agent-control-protocol.md` §11.4,
  `03-runtime/23-mobile-relay-profile.md`,
  `05-security/02-remote-control-security.md` §3.2, §3.7,
  `06-delivery/07-remote-control-rollout.md` R4

## Context

The maintainer wants to drive the agent sessions of a running PI-Desktop from
an iPhone, anywhere, in the style of the ChatGPT mobile app: see the session
list, send a prompt, watch the streamed answer, answer approvals and asktool
questions, stop a turn, and receive a push notification when a turn finishes
or needs a decision. Screen sharing or mouse/keyboard takeover is not wanted.

What already exists:

- The desktop runs every local session through the headless
  `packages/agent-host` module (`electron/main/agent-host-bridge.ts`), which
  owns the turn queue, approvals, input requests, and the epoch/sequence event
  log with replay. A late or reconnecting client can therefore attach to a live
  desktop session without missing durable events.
- `packages/racp` implements the `RACP-WS` server and client cores over an
  injected transport, device-token pairing (`ppt1.` / `pdt1.`), cursor replay,
  idempotency, and reconnect without duplicate execution.
- `03-runtime/19-remote-agent-control-protocol.md` §11.4 already specifies the
  `racp-hostlink.v1` frame vocabulary for an outbound Host-to-Gateway link.
- D385 forbids any project-operated identity, account, or relay service in the
  path, and allows a Gateway only when the user self-hosts it and it admits
  clients with Host-issued device credentials.

What is missing: the desktop exposes RACP to no client, a phone cannot reach a
loopback listener, and iOS suspends background sockets, so notifications need a
server-side sender.

The maintainer's design-gate answers (2026-10-17):

1. Control target: the desktop's agent sessions, not the screen.
2. Reachability: a cloud relay on the maintainer's own server, reachable from
   anywhere.
3. No account system in the first version; device pairing only.
4. Transport security: HTTPS/WSS terminated at the self-hosted relay is
   sufficient for this personal deployment; no end-to-end encryption layer.
5. The iOS app and the relay live in their own repositories
   (`pi-mobile-ios`, `pi-relay`); this repository keeps the desktop side and
   the protocol contract.

## Decision

1. **Topology.** The desktop opens one outbound WSS connection, the Host link,
   to a relay the user runs on their own server. The relay multiplexes phone
   connections onto that link with `racp-hostlink.v1`. The desktop opens no
   inbound port and Rust host-core still binds nothing (ADR 0205 decision 5).
2. **The desktop is the Agent Host.** Electron main composes a `RacpServer`
   over the existing Agent Host bridge and accepts each relayed logical
   connection through `RacpServer.accept(auth, transport)` with an in-memory
   transport. Session, turn, approval, and queue authority stay in the module;
   the relay never interprets RACP payloads. A desktop implementation of
   `RacpHostOperations` serves the remote-host profile operations the phone
   needs (session list, new chat, rename, project list, workspace list, read
   and diff); everything else answers `CAPABILITY_UNAVAILABLE`, and terminals
   stay unavailable.
   This replaces the "no desktop-side listener" rationale of ADR 0285: there is
   still no listener, and the phone is the named consumer.
3. **Identity stays Host-issued (D385 unchanged).** No account exists. A phone
   is paired by scanning a QR code shown in desktop Settings; the code carries
   the relay URL, the Host id, and a single-use, short-lived pairing token. The
   phone exchanges it through the relay with `connection/pair` for a `pdt1.`
   device token held in the iOS Keychain. The desktop alone verifies device
   tokens; the relay keeps only a Host-pushed mirror of active token hashes so
   it can refuse unknown or revoked devices before routing.
4. **Relay enrollment.** The relay admits a desktop with a one-time enrollment
   code printed by the relay operator CLI, exchanged once for a per-Host link
   credential stored with the desktop's OS-keychain encryption. The link is a
   bearer-authenticated WSS connection to a pinned relay origin, the
   "equivalent device-bound authenticated channel" of security §5.1.
5. **Roles and ceiling.** A paired phone holds `controller` and `approver`, not
   `owner`. Its turns run under the remote permission ceiling (default `ask`);
   it may answer `allow-once` / `deny` and asktool questions; `allow-session`,
   archive, terminals, and relayed tools are refused by default.
6. **Transport security.** TLS 1.2+ (1.3 preferred) terminates at the relay.
   The relay can read RACP payloads in memory; this is accepted because the
   relay is operated by the same person who owns the desktop. The relay MUST
   NOT persist payloads, prompts, transcripts, or tokens in logs. An optional
   end-to-end layer is deferred and would not change the frame vocabulary.
7. **Push.** The relay holds the user's own APNs key. The desktop sends a
   redacted `push.notify` frame (kind, ids, session title) for
   `turn.completed`, `turn.failed`, `approval.requested`, and
   `input.requested`; the relay forwards it to the phone's APNs token. Payloads
   never contain prompts, tool arguments, file content, or secrets.
8. **Opt-in.** Remote access is off by default. Turning it off, removing the
   relay, or revoking a phone closes the link or the device's logical
   connections immediately; local sessions are never affected.
9. **Scope.** Product scope gains a first-party iOS client of the desktop.
   Android, browser clients, multi-user tenancy, and a project-operated relay
   stay out of scope.

## Consequences

### Positive

- Reuses the shipped Agent Host module, `RACP-WS` cores, pairing, replay, and
  the reserved Host link vocabulary; no second protocol is invented.
- Stays inside D385: the only server is the user's own, the only client
  credential is Host-issued.
- A phone disconnect, iOS suspension, or relay outage never stops a desktop
  turn; reconnect resumes from the durable cursor.

### Costs and risks

- The desktop must implement `RacpHostOperations`, the Host link client with
  bounded reconnect, device management UI, and the push adapter.
- The relay becomes a new deployable surface with its own TLS, rate limits,
  and audit, and it can read traffic in memory (decision 6).
- Three repositories must agree on the RACP and Host link schemas; the
  generated JSON Schema fixture from `packages/shared` is the single source,
  and each repository pins a protocol version.
- The existing `HostRouteContext` signing (security §3.3) assumed a Gateway
  that authenticates users; in this profile the Host authenticates the device
  token itself, so the route context carries the presented credential instead
  of a Gateway signature (spec `23-mobile-relay-profile.md` §4).

## Alternatives considered

- **LAN only with TLS and QR pinning.** Simplest, but fails the "anywhere"
  requirement.
- **User-managed overlay network (Tailscale/WireGuard).** No relay code, but
  requires per-user network setup and gives no push path.
- **Project-operated relay with accounts.** Rejected by D385 and by the
  maintainer's answer 3.
- **End-to-end encryption from day one.** Deferred by answer 4; it would force
  generic notifications or an iOS notification service extension.
- **React Native client reusing `packages/racp`.** Rejected in favor of a
  native SwiftUI client for push, Keychain, Live Activities, and background
  behavior; Swift types are generated from the JSON Schema fixture.
