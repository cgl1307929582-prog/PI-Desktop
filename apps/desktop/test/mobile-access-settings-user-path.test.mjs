import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { loadStyles } from "./helpers/styles.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { MobileAccessPage } from "../../apps/desktop/src/components/settings/MobileAccessPage";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const label = (key, options) => i18n.t("settings.mobileAccess." + key, options);
const listeners = new Map();
const calls = [];
const logged = [];
for (const method of ["log", "info", "warn", "error", "debug"]) {
  const original = console[method].bind(console);
  console[method] = (...args) => { logged.push(args.map(String).join(" ")); original(...args); };
}
const PAYLOAD_TOKEN = "ppt1.qr-secret-token";
let status = { enabled: false, enrolled: false, hostId: "host_1", hostLabel: "Studio Mac", linkState: "not-enrolled", connectedPhones: 0, encryptionAvailable: true };
let devices = [];
let failNextEnroll = true;
let pairingLifetime = 1500;
const emit = () => { for (const callback of listeners.get(IPC.event.mobileAccessChanged) ?? []) callback(status); };
window.confirm = () => true;
window.piDesktop = { platform: "darwin", channels: IPC,
  on(channel, callback) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(callback);
    return () => listeners.get(channel).delete(callback);
  },
  async invoke(channel, input) {
    calls.push({ channel, input: input === undefined ? undefined : JSON.parse(JSON.stringify(input)) });
    if (channel === IPC.invoke.mobileAccessStatus) return { ok: true, data: status };
    if (channel === IPC.invoke.mobileAccessListDevices) return { ok: true, data: { devices } };
    if (channel === IPC.invoke.mobileAccessEnroll) {
      if (failNextEnroll) { failNextEnroll = false; return { ok: false, error: { code: "PAIRING_FAILED", message: "server text must not be shown" } }; }
      status = { ...status, enrolled: true, enabled: true, relayOrigin: "https://relay.example.com", linkState: "connected" };
      return { ok: true, data: status };
    }
    if (channel === IPC.invoke.mobileAccessCreatePairing) {
      return { ok: true, data: { payload: JSON.stringify({ v: 1, relay: "https://relay.example.com", hostId: "host_1", pairingToken: PAYLOAD_TOKEN, hostLabel: "Studio Mac" }), expiresAt: new Date(Date.now() + pairingLifetime).toISOString() } };
    }
    if (channel === IPC.invoke.mobileAccessSetEnabled) { status = { ...status, enabled: input.enabled, linkState: input.enabled ? "connected" : "disabled" }; return { ok: true, data: status }; }
    if (channel === IPC.invoke.mobileAccessRevokeDevice) { devices = devices.filter((device) => device.deviceId !== input.deviceId); return { ok: true, data: { revoked: true } }; }
    throw new Error("Unexpected IPC: " + channel);
  },
};
const check = (value, message) => { if (!value) throw new Error(message); };
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 6000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const input = (key) => document.querySelector('input[aria-label="' + label(key) + '"]');
const button = (text) => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
const fill = async (key, value) => {
  const element = input(key); check(element, "missing input " + key);
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await frame();
};
const click = async (node, what) => { check(node && !node.disabled, "action unavailable " + what); flushSync(() => node.click()); await frame(); };
const qr = () => document.querySelector('svg[role="img"][aria-label="' + label("qrLabel") + '"]');

window.mobileAccessProbe = async () => {
  const view = createRoot(document.getElementById("root"));
  flushSync(() => view.render(React.createElement(MobileAccessPage)));
  await until(() => input("relayOrigin"), "enroll form did not render");
  check(button(label("enroll")).disabled, "connect must wait for both fields");

  // A refused code shows the localized message, never the server text.
  await fill("relayOrigin", "https://relay.example.com");
  await fill("enrollmentCode", "pre1.wrong");
  await click(button(label("enroll")), "enroll");
  await until(() => document.querySelector('[role="alert"]'), "enroll error not shown");
  check(document.querySelector('[role="alert"]').textContent === label("errors.PAIRING_FAILED"), "wrong error copy");
  check(!document.body.textContent.includes("server text must not be shown"), "server message leaked");

  await fill("enrollmentCode", "pre1.right");
  await click(button(label("enroll")), "enroll again");
  await until(() => document.querySelector('button[role="switch"]'), "enrolled view did not render");
  const enrolls = calls.filter((call) => call.channel === IPC.invoke.mobileAccessEnroll);
  check(enrolls.at(-1).input.relayOrigin === "https://relay.example.com" && enrolls.at(-1).input.enrollmentCode === "pre1.right", "enroll input");
  check(document.body.textContent.includes(label("linkState.connected")), "connected badge");
  check(!input("enrollmentCode"), "enrollment code cleared from the page");

  // Pair a phone: QR appears, counts down, and disappears on expiry.
  await click(button(label("pair")), "pair");
  await until(() => qr(), "QR code not shown");
  check(document.body.textContent.includes(label("pairInstructions")), "pair instructions");
  check(!document.body.innerHTML.includes(PAYLOAD_TOKEN), "token must not be rendered as text or markup");
  await until(() => !qr(), "QR code did not expire");

  // A paired phone shows up through the change event and can be revoked.
  devices = [{ deviceId: "dev_1", label: "Li's iPhone", createdAt: new Date().toISOString(), connected: true, pushEnabled: true }];
  status = { ...status, connectedPhones: 1 };
  emit();
  await until(() => document.body.textContent.includes("Li's iPhone"), "device not listed");
  check(document.body.textContent.includes(label("online")) && document.body.textContent.includes(label("push")), "device badges");
  const revoke = document.querySelector('button[aria-label="' + label("revokeNamed", { name: "Li's iPhone" }) + '"]');
  await click(revoke, "revoke");
  await until(() => !document.body.textContent.includes("Li's iPhone"), "device not removed");
  check(calls.some((call) => call.channel === IPC.invoke.mobileAccessRevokeDevice && call.input.deviceId === "dev_1"), "revoke call");

  // Turning access off hides pairing; the QR payload never reached logs or storage.
  await click(document.querySelector('button[role="switch"]'), "toggle off");
  await until(() => calls.some((call) => call.channel === IPC.invoke.mobileAccessSetEnabled && call.input.enabled === false), "toggle call");
  await until(() => button(label("pair"))?.disabled, "pair must be disabled while off");
  check(!logged.some((line) => line.includes(PAYLOAD_TOKEN)), "payload logged");
  check(!JSON.stringify({ ...localStorage }).includes(PAYLOAD_TOKEN) && !JSON.stringify({ ...sessionStorage }).includes(PAYLOAD_TOKEN), "payload stored");
  flushSync(() => view.unmount());
  return { passed: true };
};
`;

test("Settings Mobile access user path: enroll, pair with an expiring QR code, list and revoke a phone, turn off", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "mobile-access-settings-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "styles.css"), (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 1000, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("MOBILE_ACCESS_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.mobileAccessProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8"); stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, /MOBILE_ACCESS_PROBE \{"passed":true\}/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
