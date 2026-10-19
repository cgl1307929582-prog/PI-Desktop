import { RACP_HOSTLINK_LIMITS, RACP_HOSTLINK_PROTOCOL, RACP_RELAY_PATHS } from "@pi-desktop/shared";
import WebSocket from "ws";

import type { HostLinkConnector, HostLinkSocket } from "./hostlink.js";

export type WsHostLinkOptions = {
  /** Pinned relay origin; must be `https://`. */
  relayOrigin: string;
  /** Reads the decrypted `prh1.` credential at every attempt. */
  credential: () => Promise<string | null>;
  connectTimeoutMs?: number;
  /** Extra trust anchors (tests with a self-signed relay). Verification is never disabled. */
  ca?: string | Buffer;
};

function linkError(message: string, errorCode: string): Error & { errorCode: string } {
  return Object.assign(new Error(message), { errorCode });
}

/** The `wss://…/v1/hostlink` URL for a pinned https relay origin. */
export function hostLinkUrl(relayOrigin: string): URL {
  const origin = new URL(relayOrigin);
  if (origin.protocol !== "https:") throw linkError("the relay origin must be https", "REMOTE_CONNECTION_FAILED");
  return new URL(RACP_RELAY_PATHS.hostLink, `wss://${origin.host}`);
}

/**
 * Open the Host link over `ws`: TLS only, bearer in the `Authorization`
 * header (never the URL), the `racp-hostlink.v1` subprotocol, no redirects,
 * and the 1 MiB frame bound (profile §2, §4).
 */
export function wsHostLinkConnector(options: WsHostLinkOptions): HostLinkConnector {
  return async () => {
    const url = hostLinkUrl(options.relayOrigin);
    const credential = await options.credential();
    if (!credential) throw linkError("the relay credential is unavailable", "REMOTE_AUTH_FAILED");
    return new Promise<HostLinkSocket>((resolve, reject) => {
      const socket = new WebSocket(url, [RACP_HOSTLINK_PROTOCOL], {
        headers: { Authorization: `Bearer ${credential}` },
        handshakeTimeout: options.connectTimeoutMs ?? 15_000,
        followRedirects: false,
        maxPayload: RACP_HOSTLINK_LIMITS.maxFrameBytes,
        perMessageDeflate: false,
        ...(options.ca ? { ca: options.ca } : {}),
      });
      let settled = false;
      const fail = (error: Error & { errorCode: string }) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.on("error", () => undefined);
        socket.terminate();
        reject(error);
      };
      socket.once("unexpected-response", (_request, response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        if (status === 401 || status === 403) fail(linkError(`relay refused the Host link (${status})`, "REMOTE_AUTH_FAILED"));
        else if (status >= 300 && status < 400) fail(linkError("relay redirected the Host link", "REMOTE_CONNECTION_FAILED"));
        else fail(linkError(`relay answered ${status}`, "REMOTE_CONNECTION_FAILED"));
      });
      socket.once("error", (error) => fail(linkError(error.message, "REMOTE_CONNECTION_FAILED")));
      socket.once("open", () => {
        if (socket.protocol !== RACP_HOSTLINK_PROTOCOL) {
          fail(linkError("relay did not accept racp-hostlink.v1", "PROTOCOL_MISMATCH"));
          return;
        }
        settled = true;
        socket.removeAllListeners("error");
        socket.on("error", () => undefined);
        resolve({
          send: (frame) => socket.send(frame),
          close: (code, reason) => socket.close(code ?? 1000, reason),
          onMessage: (handler) => {
            socket.on("message", (data, isBinary) => {
              if (isBinary) return;
              handler(Buffer.isBuffer(data) ? data.toString("utf8") : Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data).toString("utf8"));
            });
          },
          onClose: (handler) => socket.once("close", (code, reason) => handler({ code, reason: reason.toString() })),
        });
      });
    });
  };
}
