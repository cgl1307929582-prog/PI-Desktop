import { useEffect, useMemo, useRef, useState } from "react";
import { newSessionCollaboration, normalizeMode, type CollaborationSettings } from "@pi-desktop/shared";
import { api } from "../../../../lib/api";
import { useAppStore } from "../../../../stores/app-store";

/** A session's preference response must never update another visible composer. */
export function useSessionWorkflow(sessionId?: string) {
  const appSettings = useAppStore(state => state.settings);
  const draft = useAppStore(state => state.draftConfiguration?.collaboration);
  const defaults = useMemo(() => newSessionCollaboration(appSettings?.collaboration), [appSettings?.collaboration]);
  const [loaded, setLoaded] = useState<{ id: string; settings: CollaborationSettings }>();
  const [failure, setFailure] = useState<{ id: string; message: string }>();
  const [revision, setRevision] = useState(0);
  const current = useRef(sessionId);
  current.current = sessionId;
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setFailure(undefined);
    void api.getSessionWorkflow(sessionId).then(result => {
      if (!cancelled) setLoaded({ id: sessionId, settings: result.settings });
    }).catch(error => {
      if (!cancelled) setFailure({ id: sessionId, message: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [sessionId, revision]);

  const saved = sessionId ? loaded?.id === sessionId ? loaded.settings : defaults : draft ?? defaults;
  const error = failure?.id === sessionId ? failure?.message : undefined;
  const loading = !!sessionId && loaded?.id !== sessionId && !error;
  const save = async (settings: CollaborationSettings) => {
    if (sessionId) {
      const result = await api.setSessionWorkflow(sessionId, settings);
      if (current.current === sessionId) setLoaded({ id: sessionId, settings: result.settings });
    } else {
      useAppStore.setState(state => ({ draftConfiguration: {
        mode: normalizeMode(state.settings?.defaultMode),
        ...state.draftConfiguration, collaboration: { ...settings },
      } }));
    }
  };
  return { saved, loading, error, save, retry: () => setRevision(value => value + 1) };
}
