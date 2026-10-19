import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MobileAccessLinkState } from "@pi-desktop/shared";

import { SettingsCard, SettingsRow } from "../../features/settings/primitives";
import { useMobileAccess } from "../../features/settings/use-mobile-access";
import { Badge, Button, Field, Input, PasswordInput, SettingsToggle } from "../ui";
import { QrCode } from "./QrCode";

const KNOWN_ERRORS = new Set([
  "INVALID_ARGUMENT",
  "PAIRING_FAILED",
  "REMOTE_CONNECTION_FAILED",
  "REMOTE_AUTH_FAILED",
  "ENCRYPTION_UNAVAILABLE",
  "AGENT_UNAVAILABLE",
]);

function linkTone(state: MobileAccessLinkState): "neutral" | "success" | "error" | "warning" {
  if (state === "connected") return "success";
  if (state === "error") return "error";
  if (state === "connecting" || state === "reconnecting") return "warning";
  return "neutral";
}

function useSecondsLeft(expiresAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000)) : 0;
}

function formatStamp(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/** Settings → Mobile access (D663 / ADR 0331). */
export function MobileAccessPage() {
  const { t } = useTranslation();
  const m = (key: string, options?: Record<string, unknown>) => t(`settings.mobileAccess.${key}`, options ?? {});
  const access = useMobileAccess();
  const [relayOrigin, setRelayOrigin] = useState("");
  const [enrollmentCode, setEnrollmentCode] = useState("");
  const [hostLabel, setHostLabel] = useState("");
  const secondsLeft = useSecondsLeft(access.pairing?.expiresAt);
  const status = access.status;

  const errorText = access.error
    ? m(KNOWN_ERRORS.has(access.error.code) ? `errors.${access.error.code}` : "errors.generic")
    : null;

  if (!status) {
    return (
      <div className="settings-stack">
        <SettingsCard title={m("title")}>
          <p className="text-sm text-text-secondary">{errorText ?? m("loading")}</p>
        </SettingsCard>
      </div>
    );
  }

  const submitEnroll = async () => {
    const ok = await access.enroll(relayOrigin, enrollmentCode, hostLabel);
    if (ok) {
      setEnrollmentCode("");
      setRelayOrigin("");
    }
  };

  return (
    <div className="settings-stack settings-mobile-access">
      <SettingsCard title={m("relayTitle")} description={m("relayDescription")}>
        {!status.encryptionAvailable ? (
          <p className="text-sm text-text-secondary" role="note">
            {m("encryptionUnavailable")}
          </p>
        ) : null}
        {!status.enrolled ? (
          <form
            className="settings-mobile-enroll"
            onSubmit={(event) => {
              event.preventDefault();
              void submitEnroll();
            }}
          >
            <Field label={m("relayOrigin")}>
              <Input
                aria-label={m("relayOrigin")}
                placeholder="https://relay.example.com"
                value={relayOrigin}
                onChange={(event) => setRelayOrigin(event.target.value)}
                inputMode="url"
              />
            </Field>
            <Field label={m("enrollmentCode")}>
              <PasswordInput
                aria-label={m("enrollmentCode")}
                placeholder="pre1.…"
                value={enrollmentCode}
                onChange={(event) => setEnrollmentCode(event.target.value)}
                showLabel={m("showCode")}
                hideLabel={m("hideCode")}
                autoComplete="off"
              />
            </Field>
            <Field label={m("hostLabel")}>
              <Input
                aria-label={m("hostLabel")}
                placeholder={status.hostLabel}
                value={hostLabel}
                onChange={(event) => setHostLabel(event.target.value)}
              />
            </Field>
            <div className="settings-mobile-actions">
              <Button
                type="submit"
                variant="primary"
                disabled={access.busy !== null || !relayOrigin.trim() || !enrollmentCode.trim() || !status.encryptionAvailable}
              >
                {access.busy === "enroll" ? m("enrolling") : m("enroll")}
              </Button>
            </div>
          </form>
        ) : (
          <>
            <SettingsRow title={m("enabled")}>
              <SettingsToggle
                checked={status.enabled}
                label={m("enabled")}
                busy={access.busy === "toggle"}
                onChange={() => void access.setEnabled(!status.enabled)}
              />
            </SettingsRow>
            <SettingsRow title={m("relayOrigin")} detail={status.relayOrigin}>
              <Badge tone={linkTone(status.linkState)}>{m(`linkState.${status.linkState}`)}</Badge>
            </SettingsRow>
            <SettingsRow title={m("unenroll")} description={m("unenrollDescription")}>
              <Button
                variant="secondary"
                disabled={access.busy !== null}
                onClick={() => {
                  if (window.confirm(m("unenrollConfirm"))) void access.unenroll();
                }}
              >
                {m("unenroll")}
              </Button>
            </SettingsRow>
          </>
        )}
        {errorText ? (
          <p className="text-sm settings-mobile-error" role="alert">
            {errorText}
          </p>
        ) : null}
      </SettingsCard>

      {status.enrolled ? (
        <SettingsCard
          title={m("phonesTitle")}
          action={
            <Button
              variant="primary"
              size="sm"
              disabled={!status.enabled || access.busy !== null}
              onClick={() => void access.createPairing()}
            >
              {m("pair")}
            </Button>
          }
        >
          {access.pairing ? (
            <div className="settings-mobile-pairing" aria-live="polite">
              <QrCode value={access.pairing.payload} label={m("qrLabel")} />
              <div className="settings-mobile-pairing-text">
                <p className="text-sm">{m("pairInstructions")}</p>
                <p className="text-sm text-text-secondary">{m("expiresIn", { seconds: secondsLeft })}</p>
                <Button variant="secondary" size="sm" onClick={access.closePairing}>
                  {m("pairDone")}
                </Button>
              </div>
            </div>
          ) : null}
          {access.devices.length === 0 ? (
            <p className="text-sm text-text-secondary">{m("noPhones")}</p>
          ) : (
            <ul className="settings-mobile-device-list" aria-label={m("phonesTitle")}>
              {access.devices.map((device) => (
                <li key={device.deviceId} className="settings-mobile-device">
                  <div className="settings-mobile-device-main">
                    <span className="settings-mobile-device-name">{device.label}</span>
                    <span className="text-xs text-text-secondary">
                      {device.lastSeenAt ? m("lastSeen", { time: formatStamp(device.lastSeenAt) }) : m("paired", { time: formatStamp(device.createdAt) })}
                    </span>
                  </div>
                  <Badge tone={device.connected ? "success" : "neutral"}>{device.connected ? m("online") : m("offline")}</Badge>
                  {device.pushEnabled ? <Badge tone="neutral">{m("push")}</Badge> : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={access.busy !== null}
                    aria-label={m("revokeNamed", { name: device.label })}
                    onClick={() => {
                      if (window.confirm(m("revokeConfirm", { name: device.label }))) void access.revoke(device.deviceId);
                    }}
                  >
                    {m("revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>
      ) : null}
    </div>
  );
}
