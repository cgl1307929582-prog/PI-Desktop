import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixtureSource = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ComposerCollaborationPicker } from "../../apps/desktop/src/features/chat/composer/ComposerCollaborationPicker";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import "../../apps/desktop/src/styles/tokens.css";
import "../../apps/desktop/src/styles/ui-kit.css";
import "../../apps/desktop/src/styles/settings.css";
import "../../apps/desktop/src/styles/composer-collaboration.css";

let persisted = { defaultMode: "agent", defaultPermissionMode: "auto", theme: "dark", language: "en", developerMode: false };
let failSave = false;
const writes = [];
window.piDesktop = { platform: "darwin", on() { return () => {}; }, async invoke(channel, value) {
  if (channel !== "pi-desktop/settings/set") throw new Error("Unexpected IPC " + channel);
  if (failSave) return { ok: false, error: { code: "INTERNAL_ERROR", message: "Fixture save failed" } };
  persisted = structuredClone(value);
  writes.push(persisted);
  return { ok: true };
} };
await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const model = (id, availableForSubagents = true) => ({ id, availableForSubagents });
const provider = (id, name, models, enabled = true) => ({ id, name, models, enabled });
useAppStore.setState({ settings: persisted, providers: [
  provider("claude", "Claude channel", [model("claude-opus")]),
  provider("pro", "pro", [model("gpt")]),
  provider("other", "Other GPT", [model("gpt"), model("not-opted-in", false)]),
  provider("disabled", "Disabled channel", [model("hidden")], false),
] });
function Harness() {
  const [round, remount] = React.useState(0);
  const [disabled, setDisabled] = React.useState(false);
  window.remount = () => remount(value => value + 1);
  window.setDisabled = setDisabled;
  return <div style={{ position: "fixed", bottom: 24, left: 24 }}>
    <ComposerCollaborationPicker key={round} disabled={disabled} onOpen={() => {}} />
  </div>;
}
const root = createRoot(document.getElementById("root"));
flushSync(() => root.render(<Harness />));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
async function waitFor(fn, message) {
  for (let n = 0; n < 90; n++) { await settle(); if (fn()) return; }
  throw new Error(message);
}
const button = text => [...document.querySelectorAll("button")].find(el => el.textContent.trim() === text);
const label = text => [...document.querySelectorAll("button")].find(el => el.getAttribute("aria-label") === text);
async function click(el) {
  if (!el) throw new Error("Missing button");
  if (el.disabled) throw new Error("Button disabled: " + el.textContent);
  flushSync(() => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); el.click(); });
  await settle();
}
async function choose(field, option) {
  await click(label(field));
  await click([...document.querySelectorAll('[role="option"]')].find(el => el.textContent.trim() === option));
  if (!document.querySelector('[role="dialog"]')) throw new Error("Nested model choice closed the collaboration menu");
}
const trigger = () => [...document.querySelectorAll("button")].find(el => el.getAttribute("aria-label")?.startsWith("Collaboration:"));
window.collaborationProbe = async () => {
  await settle();
  if (trigger().textContent.trim() !== "Collaboration: Off") throw new Error("Default mode is not off");
  await click(trigger());
  await click(button("Auto"));
  if (!button("Save collaboration settings").disabled) throw new Error("Missing models should block save");
  await click(label("Primary developer model"));
  const listed = document.body.innerText;
  if (listed.includes("not-opted-in") || listed.includes("Disabled channel")) throw new Error("Unavailable models are selectable");
  await click(button("claude-opus · Claude channel"));
  await choose("Collaboration model", "gpt · pro");
  await choose("Workflow", "Standard development");
  await choose("Coding assignment", "Primary frontend · collaboration backend");
  await choose("Maximum concurrent subagents", "8");
  await click(button("Save collaboration settings"));
  await waitFor(() => trigger().textContent.includes("Auto"), "Saved mode not visible");
  flushSync(() => window.remount());
  await settle();
  await click(trigger());
  const pinsRestored = label("Primary developer model").textContent.includes("claude-opus")
    && label("Collaboration model").textContent.includes("gpt · pro");
  const workflowRestored = label("Workflow").textContent.includes("Standard development")
    && label("Coding assignment").textContent.includes("collaboration backend");
  await click(button("Deep"));
  await choose("Workflow", "Read-only review");
  const readOnlyAssignmentDisabled = label("Coding assignment").disabled;
  await choose("Workflow", "Deep development");
  await choose("Maximum concurrent subagents", "10");
  await click(button("Save collaboration settings"));
  await click(trigger());
  await choose("Collaboration model", "claude-opus · Claude channel");
  const sameModelBlocked = button("Save collaboration settings").disabled;
  // Escape discards the invalid draft.
  flushSync(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
  await click(trigger());
  await click(button("Off"));
  failSave = true;
  await click(button("Save collaboration settings"));
  const failurePreserved = useAppStore.getState().settings.collaboration.mode === "deep"
    && document.querySelector('[role="dialog"]') !== null;
  failSave = false;
  await click(button("Save collaboration settings"));
  flushSync(() => window.setDisabled(true));
  await settle();
  const disabledWhileRunning = trigger().disabled;
  return { pinsRestored, workflowRestored, readOnlyAssignmentDisabled, sameModelBlocked, failurePreserved, disabledWhileRunning,
    modes: writes.map(value => value.collaboration.mode),
    proPin: writes[0].collaboration.reviewModel,
    concurrency: writes[1].collaboration.maxConcurrency,
    permissionsUnchanged: writes.every(value => value.defaultPermissionMode === "auto") };
};
`;

test("composer collaboration saves pinned channels and modes without changing permissions", {
  timeout: 60_000,
  skip:
    process.platform === "linux" && !process.env.DISPLAY
      ? "Isolated Electron UI test requires a display"
      : false,
}, async () => {
  const temp = await mkdtemp(join(root, "apps/desktop/.collaboration-ui-"));
  try {
    await build({
      stdin: {
        contents: fixtureSource,
        resolveDir: join(root, "scripts", "e2e"),
        sourcefile: join(root, "scripts", "e2e", "collaboration.jsx"),
        loader: "tsx",
      },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(
      join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="renderer.css"><body><div id="root"></div><script type="module" src="renderer.js"></script>',
    );
    await writeFile(
      join(temp, "main.cjs"),
      `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.collaborationProbe()");
    console.log("COLLABORATION_PROBE " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`,
    );

    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("COLLABORATION_PROBE "));
    assert(line, output.slice(-6000));
    const result = JSON.parse(line.slice("COLLABORATION_PROBE ".length));
    assert.deepEqual(result, {
      pinsRestored: true, workflowRestored: true, readOnlyAssignmentDisabled: true,
      sameModelBlocked: true, failurePreserved: true, disabledWhileRunning: true,
      modes: ["auto", "deep", "off"], proPin: "pro/gpt", concurrency: 10, permissionsUnchanged: true,
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
