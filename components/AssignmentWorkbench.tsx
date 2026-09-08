"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Role = "adapter" | "marker" | "evaluator" | "summarizer";
type SessionEntry = {
  sessionId: string;
  role: Role;
  label: string;
  startedAt: string;
  status: "running" | "completed" | "failed";
  running: boolean;
  error?: string;
};
type Workbench = {
  assignmentId: string;
  title: string;
  displayTitle: string;
  sessions: SessionEntry[];
};
type MessageBlock = { type?: string; text?: string; toolName?: string };
type Message = {
  role?: string;
  content?: string | MessageBlock[];
  toolName?: string;
  isError?: boolean;
};

const ROLE_META: Record<Role, { index: string; title: string; description: string }> = {
  adapter: { index: "01", title: "Adapter", description: "拆分题目与学生作答" },
  marker: { index: "02", title: "Marker", description: "逐份批改并写入依据" },
  evaluator: { index: "03", title: "Evaluator", description: "更新学生画像与缓冲层" },
  summarizer: { index: "04", title: "Summarizer", description: "形成教师作业报告" },
};

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("\n");
}

function messageLabel(message: Message): string {
  if (message.role === "user") return "任务";
  if (message.role === "assistant") return "Agent";
  if (message.role === "toolResult") return message.isError ? "工具错误" : "工具返回";
  return message.toolName || "过程";
}

function statusLabel(session: SessionEntry): string {
  if (session.running) return "处理中";
  if (session.status === "failed") return "已中断";
  return "已完成";
}

export function AssignmentWorkbench({ assignmentId, onBack, onInitialReady }: {
  assignmentId: string;
  onBack?: () => void;
  onInitialReady?: () => void;
}) {
  const [workbench, setWorkbench] = useState<Workbench | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, Message[]>>({});
  const transcriptsRef = useRef<Record<string, Message[]>>({});
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    onInitialReady?.();
  }, [onInitialReady]);

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
        if (body.workbench?.sessions.some((session) => session.running)) timer = setTimeout(load, 3000);
      } catch (reason) {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "工作台读取失败");
        timer = setTimeout(load, 8000);
      }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [assignmentId]);

  const orderedSessions = useMemo(
    () => [...(workbench?.sessions ?? [])].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    [workbench],
  );
  const sessionSignature = orderedSessions.map((session) => `${session.sessionId}:${session.running}`).join("|");

  useEffect(() => {
    if (orderedSessions.length === 0) {
      transcriptsRef.current = {};
      setTranscripts({});
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setLoadingTranscript(true);
      const targets = orderedSessions.filter((session) => session.running || !(session.sessionId in transcriptsRef.current));
      const entries: Array<readonly [string, Message[]]> = [];
      for (let offset = 0; offset < targets.length; offset += 12) {
        const batch = await Promise.all(targets.slice(offset, offset + 12).map(async (session) => {
          try {
            const response = await fetch(`/api/sessions/${encodeURIComponent(session.sessionId)}?tail=1000&deferThinking=1&deferMedia=1`, { cache: "no-store" });
            const body = await response.json() as { context?: { messages?: Message[] } };
            if (!response.ok) return [session.sessionId, []] as const;
            return [session.sessionId, body.context?.messages ?? []] as const;
          } catch {
            return [session.sessionId, []] as const;
          }
        }));
        entries.push(...batch);
      }
      if (cancelled) return;
      const nextTranscripts = { ...transcriptsRef.current, ...Object.fromEntries(entries) };
      transcriptsRef.current = nextTranscripts;
      setTranscripts(nextTranscripts);
      setLoadingTranscript(false);
      if (orderedSessions.some((session) => session.running)) timer = setTimeout(load, 3000);
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  // sessionSignature changes only when a stage is added or its running state changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId, sessionSignature]);

  const completedCount = orderedSessions.filter((session) => !session.running && session.status === "completed").length;

  return <main className="assignment-workbench-page">
    <header className="assignment-workbench-page-header">
      <div><span>PROCESS ARCHIVE</span><h1>批改工作台</h1><p>查看每份作业从数据整理到报告生成的完整处理过程。</p></div>
      {onBack && <button type="button" onClick={onBack}>返回学生作业</button>}
    </header>
    <section id={`assignment-workbench-${assignmentId}`} className="assignment-workbench" aria-label="批改工作台处理过程">
    <header className="assignment-workbench-header">
      <div>
        <span>ASSIGNMENT SESSION</span>
        <h3>{workbench?.displayTitle || "本次作业处理会话"}</h3>
        <p>Adapter、Marker、Evaluator 与 Summarizer 的处理过程按时间合并展示。</p>
      </div>
      {workbench && <strong>{completedCount}/{orderedSessions.length}</strong>}
    </header>
    {error ? <p className="assignment-workbench-empty" role="alert">{error}</p> : !workbench || orderedSessions.length === 0 ? (
      <p className="assignment-workbench-empty">导入作业后，本次处理过程会自动汇入这一条作业会话。</p>
    ) : <div className="assignment-workbench-timeline" aria-live="polite">
      {orderedSessions.map((session) => {
        const meta = ROLE_META[session.role];
        const messages = transcripts[session.sessionId] ?? [];
        return <article className="assignment-workbench-segment" key={session.sessionId}>
          <header className="assignment-workbench-segment-head">
            <span className="assignment-workbench-step">{meta.index}</span>
            <div>
              <span>{meta.title}</span>
              <h4>{session.label}</h4>
              <p>{meta.description}</p>
            </div>
            <strong className={`is-${session.running ? "running" : session.status}`}>{statusLabel(session)}</strong>
          </header>
          {session.error && <p className="assignment-workbench-session-error">{session.error}</p>}
          <div className="assignment-workbench-messages">
            {loadingTranscript && messages.length === 0 ? <p>正在读取处理过程…</p> : messages.length === 0 ? <p>该处理阶段暂时没有可显示的内容。</p> : messages.map((message, index) => {
              const content = messageText(message);
              const toolCall = Array.isArray(message.content) ? message.content.find((block) => block.type === "toolCall") : undefined;
              if (!content && !toolCall) return null;
              return <div className={`assignment-workbench-message is-${message.role || "event"}`} key={`${session.sessionId}-${index}`}>
                <strong>{toolCall?.toolName ? `调用 ${toolCall.toolName}` : messageLabel(message)}</strong>
                {content && <p>{content}</p>}
              </div>;
            })}
          </div>
        </article>;
      })}
    </div>}
    </section>
  </main>;
}
