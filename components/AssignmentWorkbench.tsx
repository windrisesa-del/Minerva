"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageView } from "./MessageView";
import { ChatWindow } from "./ChatWindow";
import { normalizeToolCalls } from "@/lib/normalize";
import { ASSIGNMENT_SESSION_HISTORY_BOUNDARY } from "@/lib/assignment-session-display";
import type { AgentMessage, SessionInfo, ToolResultMessage } from "@/lib/types";

type Role = "adapter" | "marker" | "evaluator" | "summarizer";
type SessionEntry = {
  sessionId: string;
  role: Role;
  label: string;
  startedAt: string;
  status: "running" | "completed" | "failed";
  running: boolean;
  studentId?: string;
  groupId?: string;
  agentIndex?: number;
  attempt?: number;
  error?: string;
};
type SessionCluster = {
  key: string;
  role: Role;
  groupId?: string;
  parallel: boolean;
  sessions: SessionEntry[];
};
type Workbench = {
  assignmentId: string;
  title: string;
  displayTitle: string;
  currentSession?: {
    sessionId: string;
    status: "building" | "ready" | "failed";
    compacted: boolean;
    running: boolean;
    error?: string;
  };
  sessions: SessionEntry[];
};

function isAgentMessage(value: unknown): value is AgentMessage {
  return Boolean(value && typeof value === "object" && typeof (value as { role?: unknown }).role === "string");
}

function buildToolResults(messages: AgentMessage[]): Map<string, ToolResultMessage> {
  const map = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult") map.set(message.toolCallId, message);
  }
  return map;
}

function namespaceToolIds(sessionId: string, message: AgentMessage): AgentMessage {
  if (message.role === "toolResult") {
    return { ...message, toolCallId: `${sessionId}:${message.toolCallId}` };
  }
  if (message.role === "assistant" && Array.isArray(message.content)) {
    return {
      ...message,
      content: message.content.map((block) => (
        block.type === "toolCall"
          ? { ...block, toolCallId: `${sessionId}:${block.toolCallId}` }
          : block
      )),
    };
  }
  return message;
}

function clusterSessions(sessions: SessionEntry[]): SessionCluster[] {
  const clusters: SessionCluster[] = [];
  for (const session of sessions) {
    const last = clusters[clusters.length - 1];
    if (session.groupId && last?.groupId === session.groupId) {
      last.sessions.push(session);
      last.parallel = last.sessions.length > 1;
      continue;
    }
    clusters.push({
      key: session.groupId || session.sessionId,
      role: session.role,
      groupId: session.groupId,
      parallel: false,
      sessions: [session],
    });
  }
  return clusters;
}

function parallelSummary(cluster: SessionCluster): string {
  const count = new Set(cluster.sessions.map((session) => session.agentIndex ?? session.sessionId)).size;
  const role = cluster.role === "evaluator" ? "Evaluator" : "Marker";
  return `调用 ${count} 个并行执行的 ${role}`;
}

function agentHeading(session: SessionEntry, index: number): string {
  const number = session.agentIndex ?? index + 1;
  const retry = session.attempt && session.attempt > 1 ? ` · 重试 ${session.attempt}` : "";
  return `Agent ${number} · ${session.label}${retry}`;
}

export function AssignmentWorkbench({ assignmentId, showProcess, onProcessAvailabilityChange, onInitialReady }: {
  assignmentId: string;
  onBack?: () => void;
  showProcess: boolean;
  onProcessAvailabilityChange?: (available: boolean) => void;
  onInitialReady?: () => void;
}) {
  const [workbench, setWorkbench] = useState<Workbench | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, AgentMessage[]>>({});
  const transcriptsRef = useRef<Record<string, AgentMessage[]>>({});
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [currentSessionInfo, setCurrentSessionInfo] = useState<SessionInfo | null>(null);
  const legacySessionRequested = useRef(false);
  const [workbenchRefreshKey, setWorkbenchRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const ensureLegacyCurrentSession = useCallback(async () => {
    if (legacySessionRequested.current) return;
    legacySessionRequested.current = true;
    try {
      const response = await fetch(`/api/assignment-workbench?assignment_id=${encodeURIComponent(assignmentId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "当前会话创建失败");
      setWorkbenchRefreshKey((value) => value + 1);
    } catch (reason) {
      legacySessionRequested.current = false;
      throw reason;
    }
  }, [assignmentId]);

  useEffect(() => {
    onInitialReady?.();
  }, [onInitialReady]);

  useEffect(() => {
    onProcessAvailabilityChange?.(Boolean(currentSessionInfo));
  }, [currentSessionInfo, onProcessAvailabilityChange]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(`/api/assignment-workbench?assignment_id=${encodeURIComponent(assignmentId)}`, { cache: "no-store" });
        const body = await response.json() as { workbench?: Workbench | null; error?: string };
        if (!response.ok) throw new Error(body.error || "工作台读取失败");
        if (cancelled) return;
        setWorkbench(body.workbench ?? null);
        setError("");
        if (body.workbench?.sessions.some((session) => session.running)
          || body.workbench?.currentSession?.status === "building"
          || body.workbench?.currentSession?.running) timer = setTimeout(load, 3000);
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "工作台读取失败");
        timer = setTimeout(load, 8000);
      }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [assignmentId, workbenchRefreshKey]);

  const orderedSessions = useMemo(
    () => [...(workbench?.sessions ?? [])].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    [workbench],
  );
  const sessionSignature = `${orderedSessions.map((session) => `${session.sessionId}:${session.running}`).join("|")}|${workbench?.currentSession?.sessionId ?? ""}:${workbench?.currentSession?.status ?? ""}`;
  const currentSessionId = workbench?.currentSession?.sessionId;
  const currentSessionStatus = workbench?.currentSession?.status;

  useEffect(() => {
    if (!workbench || workbench.currentSession || legacySessionRequested.current) return;
    const completed = workbench.sessions.some((session) => session.role === "summarizer" && session.status === "completed");
    const running = workbench.sessions.some((session) => session.running);
    if (!completed || running) return;
    void ensureLegacyCurrentSession().catch((reason) => {
      setError(reason instanceof Error ? reason.message : "当前会话创建失败");
    });
  }, [ensureLegacyCurrentSession, workbench]);

  useEffect(() => {
    if (!currentSessionId || currentSessionStatus !== "ready") {
      setCurrentSessionInfo(null);
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { info?: SessionInfo; error?: string };
        if (!response.ok || !body.info) {
          if (response.status === 404) {
            legacySessionRequested.current = false;
            await ensureLegacyCurrentSession();
            return;
          }
          throw new Error(body.error || "当前会话读取失败");
        }
        setCurrentSessionInfo(body.info);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "当前会话读取失败");
      });
    return () => controller.abort();
  }, [currentSessionId, currentSessionStatus, ensureLegacyCurrentSession]);

  useEffect(() => {
    const requestedSessions = orderedSessions;
    if (requestedSessions.length === 0) {
      transcriptsRef.current = {};
      setTranscripts({});
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setLoadingTranscript(true);
      const targets = requestedSessions.filter((session) => session.running || !(session.sessionId in transcriptsRef.current));
      const entries: Array<readonly [string, AgentMessage[]]> = [];
      for (let offset = 0; offset < targets.length; offset += 12) {
        const batch = await Promise.all(targets.slice(offset, offset + 12).map(async (session) => {
          try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}?tail=1000&deferThinking=1&deferMedia=1`, { cache: "no-store" });
            const body = await response.json() as { context?: { messages?: unknown[] } };
            if (!response.ok) return [session.sessionId, [] as AgentMessage[]] as const;
            const messages = (body.context?.messages ?? [])
              .filter(isAgentMessage)
              .map((message) => normalizeToolCalls(message));
            return [session.sessionId, messages] as const;
          } catch {
            return [session.sessionId, [] as AgentMessage[]] as const;
          }
        }));
        entries.push(...batch);
      }
      if (cancelled) return;
      const nextTranscripts = { ...transcriptsRef.current, ...Object.fromEntries(entries) };
      transcriptsRef.current = nextTranscripts;
      setTranscripts(nextTranscripts);
      setLoadingTranscript(false);
      if (requestedSessions.some((session) => session.running)) timer = setTimeout(load, 3000);
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  // sessionSignature changes only when a stage is added or its running state changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId, sessionSignature]);

  const clusters = useMemo(() => clusterSessions(orderedSessions), [orderedSessions]);
  const timeline = useMemo(() => {
    const items: Array<{ sessionId: string; message: AgentMessage; index: number }> = [];
    for (const session of orderedSessions) {
      const messages = transcripts[session.sessionId] ?? [];
      messages.forEach((message, index) => {
        items.push({ sessionId: session.sessionId, message: namespaceToolIds(session.sessionId, message), index });
      });
    }
    return items;
  }, [orderedSessions, transcripts]);
  const toolResults = useMemo(() => buildToolResults(timeline.map((item) => item.message)), [timeline]);
  const messagesBySession = useMemo(() => {
    const map = new Map<string, AgentMessage[]>();
    for (const item of timeline) {
      const list = map.get(item.sessionId) ?? [];
      list.push(item.message);
      map.set(item.sessionId, list);
    }
    return map;
  }, [timeline]);

  if (!showProcess && currentSessionInfo) {
    return (
      <div id={`assignment-workbench-${assignmentId}`} className="assignment-workbench-current-session relative h-full min-w-0 overflow-hidden" aria-label="批改工作台当前会话">
        <ChatWindow
          key={currentSessionInfo.id}
          session={currentSessionInfo}
          sessionRunning={workbench?.currentSession?.running === true}
          newSessionCwd={null}
          newSessionDraftKey={null}
          hideHistoryThroughAssistantText={ASSIGNMENT_SESSION_HISTORY_BOUNDARY}
        />
      </div>
    );
  }

  return (
    <div
      id={`assignment-workbench-${assignmentId}`}
      className="minerva-chat assignment-workbench-chat relative flex h-full min-w-0 flex-col overflow-hidden"
      aria-label="批改工作台处理过程"
    >
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <div className="assignment-workbench-scroll min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4">
          <div style={{ minWidth: 0, padding: "0 16px" }}>
            <div style={{ width: "100%", minWidth: 0, maxWidth: 820, margin: "0 auto" }}>
              {error ? (
                <p className="assignment-workbench-empty" role="alert">{error}</p>
              ) : !workbench || orderedSessions.length === 0 ? (
                <p className="assignment-workbench-empty">导入作业后，本次处理过程会自动汇入这一条作业会话。</p>
              ) : loadingTranscript && timeline.length === 0 ? (
                <p className="assignment-workbench-empty">正在读取处理过程…</p>
              ) : timeline.length === 0 && clusters.length === 0 ? (
                <p className="assignment-workbench-empty">暂时没有可显示的内容。</p>
              ) : clusters.map((cluster) => {
                const parallel = cluster.parallel && (cluster.role === "marker" || cluster.role === "evaluator");
                const expanded = expandedGroups[cluster.key] === true;
                if (parallel && !expanded) {
                  return (
                    <button
                      key={cluster.key}
                      type="button"
                      className="assignment-workbench-parallel-summary"
                      onClick={() => setExpandedGroups((current) => ({ ...current, [cluster.key]: true }))}
                    >
                      {parallelSummary(cluster)}
                    </button>
                  );
                }
                return (
                  <section key={cluster.key} className={parallel ? "assignment-workbench-parallel-group" : undefined}>
                    {parallel ? (
                      <button
                        type="button"
                        className="assignment-workbench-parallel-summary is-open"
                        onClick={() => setExpandedGroups((current) => ({ ...current, [cluster.key]: false }))}
                      >
                        {parallelSummary(cluster)}
                      </button>
                    ) : null}
                    {cluster.sessions.map((session, sessionIndex) => {
                      const messages = messagesBySession.get(session.sessionId) ?? [];
                      return (
                        <div key={session.sessionId} className="assignment-workbench-agent">
                          {parallel ? <h3 className="assignment-workbench-agent-heading">{agentHeading(session, sessionIndex)}</h3> : null}
                          {messages.map((message, index) => (
                            <MessageView
                              key={`${session.sessionId}-${index}`}
                              message={message}
                              toolResults={toolResults}
                              sessionId={session.sessionId}
                              showTimestamp={message.role === "assistant"}
                              prevTimestamp={index > 0 ? messages[index - 1]?.timestamp : undefined}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
