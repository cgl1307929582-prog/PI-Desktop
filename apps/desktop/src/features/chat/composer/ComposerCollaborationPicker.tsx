import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  COLLABORATION_MODES, COLLABORATION_WORKFLOWS, COLLABORATION_CODING_MODES,
  isCollaborationSettings,
  type CollaborationSettings,
} from "@pi-desktop/shared";
import { useSessionWorkflow } from "./hooks/useSessionWorkflow";
import { useAppStore } from "../../../stores/app-store";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { SettingsMenuSelect } from "../../../components/settings/SettingsMenuSelect";
import { Button, Field, SegmentedControl, TooltipButton } from "../../../components/ui";
import { IconChevronDown } from "../../../components/icons";

/** The composer is the entry point; saving a mode never changes permissions. */
export function ComposerCollaborationPicker({ disabled, onOpen, sessionId }: {
  sessionId?: string;
  disabled: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const providers = useAppStore((state) => state.providers);
  const showToast = useAppStore((state) => state.showToast);
  const preference = useSessionWorkflow(sessionId);
  const saved = preference.saved;
  const workflowLabel = t(`collaboration.workflows.${saved.workflow ?? "adaptive"}`);
  const displayMode = t(`collaboration.${saved.mode}`) + (saved.mode === "off" ? ""
    : ` · ${saved.workflow === "auto" ? workflowLabel : t("collaboration.lockedWorkflow", { workflow: workflowLabel })}`);
  const [draft, setDraft] = useState<CollaborationSettings>(saved);
  // A successful retry must display the recovered choice before it can be saved.
  useEffect(() => setDraft({ ...saved }), [saved]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const models = useMemo(() => providers.filter((provider) => provider.enabled).flatMap((provider) =>
    provider.models.filter((model) => model.availableForSubagents).map((model) => ({
      id: `${provider.id}/${model.id}`, label: `${model.id} · ${provider.name}`,
    }))), [providers]);
  const available = new Set(models.map((model) => model.id));
  const options = [{ id: "", label: t("collaboration.chooseModel") }, ...models];
  const choices = (pin: string) => pin && !available.has(pin)
    ? [...options, { id: pin, label: t("collaboration.unavailableModel", { model: pin }), disabled: true }]
    : options;
  const configured = available.has(draft.executionModel) && available.has(draft.reviewModel)
    && draft.executionModel !== draft.reviewModel;
  const canSave = !!settings && !preference.loading && !preference.error && isCollaborationSettings(draft) && (draft.mode === "off" || configured);

  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      await preference.save({ ...draft });
      setOpen(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally { setBusy(false); }
  };

  return <AnchoredMenu
    open={open && !disabled}
    onClose={() => { if (!busy) setOpen(false); }}
    menuClassName="composer-collaboration-menu"
    label={t("collaboration.title")}
    role="dialog"
    align="start"
    side="top"
    trigger={(ref) => <TooltipButton
      ref={ref} type="button" className="icon-btn mode-chip"
      tooltip={t("collaboration.title")}
      ariaLabel={t("collaboration.trigger", { mode: displayMode })}
      aria-haspopup="dialog" aria-expanded={open && !disabled}
      disabled={disabled || !settings || preference.loading}
      onClick={() => { onOpen(); setDraft({ ...saved }); setOpen((value) => !value); }}
    >
      <span className="text-sm">{t("collaboration.trigger", { mode: displayMode })}</span>
      <IconChevronDown size={12} />
    </TooltipButton>}
  >
    {/* React portal events bubble here too; choosing an inner menu option
        must not look like an outside click to the outer AnchoredMenu. */}
    <div className="composer-collaboration-content" role="presentation"
      onMouseDown={(event) => event.stopPropagation()}>
      <strong>{t("collaboration.title")}</strong>
      {preference.error ? <div role="alert"><p>{preference.error}</p>
        <Button size="sm" onClick={preference.retry}>{t("collaboration.retry")}</Button></div> : null}
      <SegmentedControl value={draft.mode} label={t("collaboration.mode")}
        options={COLLABORATION_MODES.map((mode) => ({ value: mode, label: t(`collaboration.${mode}`) }))}
        disabled={busy}
        onChange={(mode) => setDraft((value) => ({ ...value, mode }))} />
      <p className="text-xs text-muted">{t(`collaboration.description.${draft.mode}`)}</p>
      <Field label={t("collaboration.workflow")}>
        <SettingsMenuSelect value={draft.workflow ?? "adaptive"}
          options={COLLABORATION_WORKFLOWS.map(id => ({ id, label: t(`collaboration.workflows.${id}`) }))}
          label={t("collaboration.workflow")} disabled={busy} fullWidth
          onChange={(workflow) => setDraft(value => ({ ...value, workflow: workflow as CollaborationSettings["workflow"] }))} />
      </Field>
      <p className="text-xs text-muted">{t(draft.workflow === "auto" ? "collaboration.automaticWorkflowHint" : "collaboration.lockedWorkflowHint")}</p>
      {draft.mode === "auto" ? <p className="text-xs text-muted">{t("collaboration.smartWorkflowHint")}</p> : null}
      <Field label={t("collaboration.codingMode")}>
        <SettingsMenuSelect value={draft.codingMode ?? "primary"}
          options={COLLABORATION_CODING_MODES.map(id => ({ id, label: t(`collaboration.codingModes.${id}`) }))}
          label={t("collaboration.codingMode")} disabled={busy || draft.workflow === "review"} fullWidth
          onChange={(codingMode) => setDraft(value => ({ ...value, codingMode: codingMode as CollaborationSettings["codingMode"] }))} />
      </Field>
      <p className="text-xs text-muted">{t("collaboration.workflowHint")}</p>
      <Field label={t("collaboration.executionModel")}>
        <SettingsMenuSelect value={draft.executionModel} options={choices(draft.executionModel)}
          label={t("collaboration.executionModel")} disabled={busy} fullWidth
          onChange={(executionModel) => setDraft((value) => ({ ...value, executionModel }))} />
      </Field>
      <Field label={t("collaboration.reviewModel")}>
        <SettingsMenuSelect value={draft.reviewModel} options={choices(draft.reviewModel)}
          label={t("collaboration.reviewModel")} disabled={busy} fullWidth
          onChange={(reviewModel) => setDraft((value) => ({ ...value, reviewModel }))} />
      </Field>
      <Field label={t("collaboration.concurrency")}>
        <SettingsMenuSelect value={String(draft.maxConcurrency)}
          options={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((count) => ({ id: String(count), label: String(count) }))}
          label={t("collaboration.concurrency")} disabled={busy}
          onChange={(value) => setDraft((current) => ({ ...current, maxConcurrency: Number(value) }))} />
      </Field>
      {draft.mode !== "off" && !configured ? <p role="status" className="text-xs text-muted">{t("collaboration.modelHint")}</p> : null}
      <p className="text-xs text-muted">{t("collaboration.scope")}</p>
      <Button size="sm" disabled={!canSave || busy} onClick={() => void save()}>{t("collaboration.save")}</Button>
    </div>
  </AnchoredMenu>;
}
