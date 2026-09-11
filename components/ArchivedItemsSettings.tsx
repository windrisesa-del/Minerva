"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { SessionInfo } from "@/lib/types";

interface ArchivedWorkbench {
  assignmentId: string;
  displayTitle: string;
  archivedAt?: string;
}

const DEFAULT_VISIBLE_COUNT = 6;

export function ArchivedItemsSettings({ onChanged }: { onChanged: () => void }) {
  const { locale, t } = useI18n();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [workbenches, setWorkbenches] = useState<ArchivedWorkbench[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatsExpanded, setChatsExpanded] = useState(false);
  const [workbenchesExpanded, setWorkbenchesExpanded] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState<SessionInfo | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sessionResponse, workbenchResponse] = await Promise.all([
        fetch("/api/sessions?force=1", { cache: "no-store" }),
        fetch("/api/assignment-workbench", { cache: "no-store" }),
      ]);
      const sessionBody = await sessionResponse.json() as { archivedSessions?: SessionInfo[]; error?: string };
      const workbenchBody = await workbenchResponse.json() as { archivedWorkbenches?: ArchivedWorkbench[]; error?: string };
      if (!sessionResponse.ok) throw new Error(sessionBody.error || `HTTP ${sessionResponse.status}`);
      if (!workbenchResponse.ok) throw new Error(workbenchBody.error || `HTTP ${workbenchResponse.status}`);
      setSessions((sessionBody.archivedSessions ?? [])
        .filter((session) => !session.minervaInternal)
        .sort((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "")));
      setWorkbenches((workbenchBody.archivedWorkbenches ?? [])
        .sort((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "")));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const restoreSession = async (sessionId: string) => {
    setBusyId(sessionId);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const requestDeleteSession = (session: SessionInfo) => {
    setError(null);
    setDeletePrompt(session);
  };

  const deleteSessionForever = async (session: SessionInfo) => {
    setBusyId(session.id);
    setError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "DELETE",
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setDeletePrompt(null);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreWorkbench = async (assignmentId: string) => {
    setBusyId(assignmentId);
    setError(null);
    try {
      const response = await fetch(`/api/assignment-workbench?assignment_id=${encodeURIComponent(assignmentId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const sessionTitle = (session: SessionInfo) => session.name || session.firstMessage.slice(0, 50) || session.id.slice(0, 12);
  const visibleSessions = chatsExpanded ? sessions : sessions.slice(0, DEFAULT_VISIBLE_COUNT);
  const visibleWorkbenches = workbenchesExpanded ? workbenches : workbenches.slice(0, DEFAULT_VISIBLE_COUNT);

  return (
    <div className="settings-archives">
      <h2>{t("settings.archives")}</h2>
      <p className="settings-archives-description">{t("settings.archivesDescription")}</p>
      {error && <p role="alert" className="settings-general-error">{error}</p>}
      {loading ? <p className="settings-archives-empty">{t("sidebar.loading")}</p> : (
        <>
          <section className="settings-archive-group">
            <header><h3>{t("settings.archivedChats")}</h3><span>{sessions.length}</span></header>
            {sessions.length === 0 ? <p className="settings-archives-empty">{t("settings.noArchivedChats")}</p> : (
              <div className="settings-archive-list">
                {visibleSessions.map((session) => (
                  <article key={session.id} className="settings-archive-row">
                    <div><strong>{sessionTitle(session)}</strong><small>{session.cwd} · {session.archivedAt ? formatRelativeTime(session.archivedAt, locale) : ""}</small></div>
                    <div className="settings-archive-actions">
                      <button type="button" onClick={() => void restoreSession(session.id)} disabled={busyId === session.id}>{t("settings.restore")}</button>
                      <button type="button" className="settings-archive-delete" onClick={() => requestDeleteSession(session)} disabled={busyId === session.id}>{t("settings.deleteForever")}</button>
                    </div>
                  </article>
                ))}
                {sessions.length > DEFAULT_VISIBLE_COUNT && (
                  <button type="button" className="settings-archive-expand" onClick={() => setChatsExpanded((expanded) => !expanded)}>
                    {chatsExpanded ? t("settings.collapseArchives") : t("settings.expandArchives", { count: sessions.length - DEFAULT_VISIBLE_COUNT })}
                  </button>
                )}
              </div>
            )}
          </section>

          <section className="settings-archive-group">
            <header><h3>{t("settings.archivedWorkbenches")}</h3><span>{workbenches.length}</span></header>
            {workbenches.length === 0 ? <p className="settings-archives-empty">{t("settings.noArchivedWorkbenches")}</p> : (
              <div className="settings-archive-list">
                {visibleWorkbenches.map((workbench) => (
                  <article key={workbench.assignmentId} className="settings-archive-row">
                    <div><strong>{workbench.displayTitle}</strong><small>{workbench.archivedAt ? formatRelativeTime(workbench.archivedAt, locale) : ""}</small></div>
                    <div className="settings-archive-actions">
                      <button type="button" onClick={() => void restoreWorkbench(workbench.assignmentId)} disabled={busyId === workbench.assignmentId}>{t("settings.restore")}</button>
                    </div>
                  </article>
                ))}
                {workbenches.length > DEFAULT_VISIBLE_COUNT && (
                  <button type="button" className="settings-archive-expand" onClick={() => setWorkbenchesExpanded((expanded) => !expanded)}>
                    {workbenchesExpanded ? t("settings.collapseArchives") : t("settings.expandArchives", { count: workbenches.length - DEFAULT_VISIBLE_COUNT })}
                  </button>
                )}
              </div>
            )}
          </section>
        </>
      )}
      {deletePrompt && (
        <div
          className="settings-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && busyId !== deletePrompt.id) setDeletePrompt(null);
          }}
        >
          <div className="settings-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-archived-chat-title">
            <h2 id="delete-archived-chat-title">{t("settings.deleteChatTitle")}</h2>
            <p className="settings-confirm-lead">{sessionTitle(deletePrompt)}</p>
            <p className="settings-confirm-copy">{t("settings.deleteChatConfirm")}</p>
            <div className="settings-confirm-actions">
              <button
                type="button"
                className="settings-confirm-secondary"
                disabled={busyId === deletePrompt.id}
                onClick={() => setDeletePrompt(null)}
              >
                {t("i18n.cancel")}
              </button>
              <button
                type="button"
                className="settings-confirm-danger"
                disabled={busyId === deletePrompt.id}
                onClick={() => void deleteSessionForever(deletePrompt)}
              >
                {busyId === deletePrompt.id ? t("settings.deletingForever") : t("settings.deleteForever")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
