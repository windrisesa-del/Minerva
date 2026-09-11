"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AssignmentSummary } from "./AssignmentSummary";
import { apiErrorMessage } from "@/lib/api-error-message";
import type {
  AssignmentClassOption,
  AssignmentDetailResponse,
  AssignmentImportResponse,
  AssignmentListResponse,
  AssignmentStatus,
  GradingRun,
} from "@/lib/student-assignment-types";

interface Props {
  onInitialReady?: () => void;
  workspaceCwd?: string | null;
  onOpenWorkbench?: (assignmentId: string) => void;
}

const STATUS_LABELS: Record<AssignmentStatus, string> = {
  draft: "草稿",
  ungraded: "未批改",
  grading: "批改中",
  graded: "完成批改",
  archived: "已归档",
};

const PROCESSING_FAILURE_HISTORY_KEY = "minerva:shown-processing-failures:v1";

function processingFailureKey(run: GradingRun) {
  return `${run.assignmentId}:${run.failedAt || run.startedAt}`;
}

function formatDate(value: string | null, includeTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

export function StudentAssignments({ onInitialReady, onOpenWorkbench }: Props) {
  const [data, setData] = useState<AssignmentListResponse | null>(null);
  const [detail, setDetail] = useState<AssignmentDetailResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"current" | AssignmentStatus>("current");
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [archivePrompt, setArchivePrompt] = useState<{ id: string; title: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [classes, setClasses] = useState<AssignmentClassOption[]>([]);
  const [importTitle, setImportTitle] = useState("");
  const [importClassId, setImportClassId] = useState("");
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<AssignmentImportResponse | null>(null);
  const [gradingRuns, setGradingRuns] = useState<Record<string, GradingRun>>({});
  const [evaluatorRuns, setEvaluatorRuns] = useState<Record<string, GradingRun>>({});
  const [shownFailureKeys, setShownFailureKeys] = useState<Set<string>>(new Set());
  const [failureHistoryReady, setFailureHistoryReady] = useState(false);
  const [visibleProcessingFailure, setVisibleProcessingFailure] = useState<GradingRun | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const initialReadySent = useRef(false);
  const handledFailureRef = useRef<string | null>(null);

  const markInitialReady = useCallback(() => {
    if (initialReadySent.current) return;
    initialReadySent.current = true;
    onInitialReady?.();
  }, [onInitialReady]);

  const loadDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/student-assignments?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const body = await response.json() as AssignmentDetailResponse & { error?: string; detail?: string };
      if (!response.ok) throw new Error(body.error || body.detail || `HTTP ${response.status}`);
      setDetail(body);
    } catch (reason) {
      setDetail(null);
      setError(reason instanceof Error ? reason.message : "作业详情读取失败");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const loadAssignments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/student-assignments", { cache: "no-store" });
      const body = await response.json() as AssignmentListResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setData(body);
      const nextId = selectedId && body.assignments.some((item) => item.id === selectedId)
        ? selectedId
        : body.assignments[0]?.id ?? null;
      if (nextId) await loadDetail(nextId);
      else {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (reason) {
      setData(null);
      setDetail(null);
      setError(reason instanceof Error ? reason.message : "作业数据读取失败");
    } finally {
      setLoading(false);
      markInitialReady();
    }
  }, [loadDetail, markInitialReady, selectedId]);

  const openImport = useCallback(async () => {
    setImportOpen(true);
    setImportError(null);
    setImportResult(null);
    try {
      const response = await fetch("/api/student-assignments?resource=classes", { cache: "no-store" });
      const body = await response.json() as AssignmentClassOption[] & { error?: string; detail?: string };
      if (!response.ok) throw new Error(body.error || body.detail || `HTTP ${response.status}`);
      const options = Array.isArray(body) ? body : [];
      setClasses(options);
      setImportClassId((current) => current || options[0]?.id || "");
    } catch (reason) {
      setClasses([]);
      setImportError(reason instanceof Error ? reason.message : "班级列表读取失败");
    }
  }, []);

  const setAssignmentStatus = useCallback(async (id: string, nextStatus: AssignmentStatus) => {
    setArchivingId(id);
    setError(null);
    try {
      const response = await fetch(`/api/student-assignments?id=${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const body = await response.json() as { error?: string; detail?: string };
      if (!response.ok) throw new Error(body.error || body.detail || `HTTP ${response.status}`);
      setArchivePrompt(null);
      if (nextStatus === "archived") {
        setVisibleProcessingFailure((current) => current?.assignmentId === id ? null : current);
      }
      await loadAssignments();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "作业状态更新失败");
    } finally {
      setArchivingId(null);
    }
  }, [loadAssignments]);

  const requestArchive = useCallback((id: string, title: string) => {
    setArchivePrompt({ id, title });
  }, []);

  const openAssignmentWorkbench = useCallback((id: string) => {
    onOpenWorkbench?.(id);
  }, [onOpenWorkbench]);

  const loadGradingRuns = useCallback(async () => {
    try {
      const [gradingResponse, evaluatorResponse] = await Promise.all([
        fetch("/api/grading/runs", { cache: "no-store" }),
        fetch("/api/evaluator/runs", { cache: "no-store" }),
      ]);
      const gradingBody = await gradingResponse.json() as { runs?: GradingRun[]; error?: string };
      const evaluatorBody = await evaluatorResponse.json() as { runs?: GradingRun[]; error?: string };
      if (gradingResponse.ok) {
        const next: Record<string, GradingRun> = {};
        for (const run of gradingBody.runs ?? []) next[run.assignmentId] = run;
        setGradingRuns(next);
      }
      if (evaluatorResponse.ok) {
        const next: Record<string, GradingRun> = {};
        for (const run of evaluatorBody.runs ?? []) next[run.assignmentId] = run;
        setEvaluatorRuns(next);
      }
    } catch {
      // Keep the last known runs if the sidecar file is temporarily unreadable.
    }
  }, []);

  const submitImport = useCallback(async () => {
    if (!importTitle.trim()) {
      setImportError("请填写作业标题");
      return;
    }
    if (importFiles.length === 0) {
      setImportError("请选择 zip 或学生作业文件");
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const form = new FormData();
      form.append("title", importTitle.trim());
      if (importClassId) form.append("class_id", importClassId);
      importFiles.forEach((file) => form.append("files", file));
      const response = await fetch("/api/student-assignments", { method: "POST", body: form });
      const body = await response.json() as AssignmentImportResponse & { error?: unknown; detail?: unknown };
      if (!response.ok) throw new Error(apiErrorMessage(body, `导入失败（HTTP ${response.status}）`));
      const adapterResponse = await fetch("/api/adapter/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignmentId: body.assignment_id,
          title: body.title,
          sources: body.adapter_sources,
          unmatched: body.unmatched,
        }),
      });
      const adapterBody = await adapterResponse.json() as { error?: string };
      if (!adapterResponse.ok) throw new Error(adapterBody.error || `Adapter HTTP ${adapterResponse.status}`);
      setImportResult(body);
      setImportFiles([]);
      if (importInputRef.current) importInputRef.current.value = "";
      setImportOpen(false);
      await loadAssignments();
      if (body.assignment_id) await loadDetail(body.assignment_id);
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : "作业导入失败");
    } finally {
      setImporting(false);
    }
  }, [importClassId, importFiles, importTitle, loadAssignments, loadDetail]);

  useEffect(() => {
    void loadAssignments();
    void loadGradingRuns();
    // The initial fetch is intentionally tied only to the mounted data surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(PROCESSING_FAILURE_HISTORY_KEY) || "[]");
      setShownFailureKeys(new Set(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string") : []));
    } catch {
      setShownFailureKeys(new Set());
    } finally {
      setFailureHistoryReady(true);
    }
  }, []);

  useEffect(() => {
    const gradingRunning = Object.values(gradingRuns).some((run) => run.running);
    const evaluatorRunning = Object.values(evaluatorRuns).some((run) => run.running);
    const waitingForObserver = (data?.assignments ?? []).some((item) => (
      item.status === "graded" && Boolean(gradingRuns[item.id]) && !evaluatorRuns[item.id]
    ));
    if (!gradingRunning && !evaluatorRunning && !waitingForObserver) return;
    const timer = window.setInterval(() => {
      void loadGradingRuns();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [data?.assignments, evaluatorRuns, gradingRuns, loadGradingRuns]);

  const processingFailures = useMemo(() => [
    ...Object.values(gradingRuns),
    ...Object.values(evaluatorRuns),
  ]
    .filter((run) => (run.status === "failed" || run.status === "waiting_for_reconnect") && run.error)
    .sort((left, right) => (right.failedAt || right.startedAt).localeCompare(left.failedAt || left.startedAt)), [evaluatorRuns, gradingRuns]);

  const latestProcessingFailure = processingFailures[0] ?? null;

  const displayableProcessingFailures = useMemo(() => {
    if (!data) return [];
    const archivedIds = new Set(data.assignments.filter((item) => item.status === "archived").map((item) => item.id));
    return processingFailures.filter((run) => !archivedIds.has(run.assignmentId));
  }, [data, processingFailures]);

  useEffect(() => {
    if (!latestProcessingFailure) return;
    const failureKey = processingFailureKey(latestProcessingFailure);
    if (handledFailureRef.current === failureKey) return;
    handledFailureRef.current = failureKey;
    void loadAssignments();
  }, [latestProcessingFailure, loadAssignments]);

  useEffect(() => {
    if (!failureHistoryReady || !data) return;
    if (visibleProcessingFailure) {
      const archived = data.assignments.some((item) => (
        item.id === visibleProcessingFailure.assignmentId && item.status === "archived"
      ));
      if (archived) setVisibleProcessingFailure(null);
      return;
    }
    const nextFailure = displayableProcessingFailures.find((run) => !shownFailureKeys.has(processingFailureKey(run)));
    if (!nextFailure) return;
    const nextKey = processingFailureKey(nextFailure);
    setVisibleProcessingFailure(nextFailure);
    setShownFailureKeys((current) => {
      const next = new Set(current);
      next.add(nextKey);
      try {
        window.localStorage.setItem(PROCESSING_FAILURE_HISTORY_KEY, JSON.stringify([...next].slice(-100)));
      } catch {
        // The current page still shows the notice when persistent browser storage is unavailable.
      }
      return next;
    });
  }, [data, displayableProcessingFailures, failureHistoryReady, shownFailureKeys, visibleProcessingFailure]);

  const filteredAssignments = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return (data?.assignments ?? []).filter((item) => (
      (status === "current" ? item.status !== "archived" : item.status === status)
      && (!normalized || item.title.toLocaleLowerCase("zh-CN").includes(normalized) || item.class_name.toLocaleLowerCase("zh-CN").includes(normalized))
    ));
  }, [data?.assignments, query, status]);

  return (
    <section className="assignment-center" aria-labelledby="assignment-center-title">
      <header className="assignment-center-header">
        <div className="assignment-center-title-block">
          <h1 id="assignment-center-title">学生作业</h1>
        </div>
        <div className="assignment-header-actions">
          <button className="assignment-import-button" type="button" onClick={() => void openImport()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4" /><path d="m8 8 4-4 4 4" /><path d="M5 20h14" /></svg>
            导入作业
          </button>
          <button className="assignment-refresh-button" type="button" onClick={() => void loadAssignments()} disabled={loading}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5" /><path d="M18.5 9A7 7 0 0 0 6.2 6.2L4 11m16 2-2.2 4.8A7 7 0 0 1 5.5 15" /></svg>
            {loading ? "同步中" : "刷新数据"}
          </button>
        </div>
      </header>

      {visibleProcessingFailure && (
        <div className="assignment-grading-failure" role="alert">
          <div>
            <strong>{visibleProcessingFailure.title || "作业"}{visibleProcessingFailure.status === "waiting_for_reconnect" ? "将在服务重连后继续" : "自动处理失败"}</strong>
            <span>{visibleProcessingFailure.error}</span>
          </div>
          <button type="button" aria-label="关闭这条失败提醒" onClick={() => setVisibleProcessingFailure(null)}>×</button>
        </div>
      )}

      {error ? (
        <div className="assignment-state assignment-state-error" role="alert">
          <span className="assignment-state-mark">!</span>
          <div><h2>暂时无法读取作业数据</h2><p>{error}</p></div>
          <button type="button" onClick={() => void loadAssignments()}>重试</button>
        </div>
      ) : loading && !data ? (
        <div className="assignment-state" role="status"><span className="assignment-loader" /><div><h2>正在连接学习数据库</h2><p>汇总作业与提交记录…</p></div></div>
      ) : data?.assignments.length === 0 ? (
        <div className="assignment-empty">
          <div className="assignment-empty-illustration" aria-hidden="true"><span /><span /><span /></div>
          <h2>暂无作业数据</h2>
          <p>PostgreSQL 已连接。导入作业后会显示为「未批改」；批改完成后更新为「完成批改」。</p>
          <div className="assignment-header-actions">
            <button type="button" onClick={() => void openImport()}>导入作业</button>
            <button type="button" onClick={() => void loadAssignments()}>重新检查</button>
          </div>
        </div>
      ) : (
        <div className="assignment-workspace">
          <aside className="assignment-index" aria-label="作业列表">
            <div className="assignment-index-toolbar">
              <label className="assignment-search">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索作业或班级" aria-label="搜索作业或班级" />
              </label>
              <select value={status} onChange={(event) => setStatus(event.target.value as "current" | AssignmentStatus)} aria-label="筛选作业状态">
                <option value="current">当前作业</option>
                <option value="ungraded">未批改</option>
                <option value="grading">批改中</option>
                <option value="draft">草稿</option>
                <option value="graded">完成批改</option>
                <option value="archived">已归档</option>
              </select>
            </div>
            <div className="assignment-index-count">{filteredAssignments.length} 份作业</div>
            <div className="assignment-index-list">
              {filteredAssignments.map((item) => (
                <div key={item.id} className="assignment-index-card" aria-current={selectedId === item.id ? "true" : undefined}>
                  <button type="button" className="assignment-index-card-main" onClick={() => void loadDetail(item.id)}>
                    <span className={`assignment-status assignment-status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
                    <strong>{item.title}</strong>
                    <span className="assignment-index-class">{item.class_name} · {item.item_count} 题</span>
                    <span className="assignment-progress-track"><i style={{ width: `${Math.min(100, item.completion_rate)}%` }} /></span>
                    <span className="assignment-index-meta"><span>{item.completed_count}/{item.student_count} 已交</span><span>{formatDate(item.due_at)} 截止</span></span>
                  </button>
                  <div className="assignment-index-card-actions">
                    {gradingRuns[item.id] && (
                      <button
                        type="button"
                        className="assignment-manage-button assignment-grade-button"
                        onClick={() => void openAssignmentWorkbench(item.id)}
                      >
                        {gradingRuns[item.id].running || evaluatorRuns[item.id]?.running ? "处理中 · 工作台" : "批改工作台"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="assignment-manage-button"
                      disabled={archivingId === item.id}
                      onClick={() => item.status === "archived" ? void setAssignmentStatus(item.id, "ungraded") : requestArchive(item.id, item.title)}
                    >
                      {item.status === "archived" ? "取消归档" : "归档"}
                    </button>
                  </div>
                </div>
              ))}
              {filteredAssignments.length === 0 && <p className="assignment-filter-empty">没有符合筛选条件的作业。</p>}
            </div>
          </aside>

          <main className="assignment-detail">
            {detailLoading ? (
              <div className="assignment-detail-loading" role="status"><span className="assignment-loader" />正在读取学生提交…</div>
            ) : detail ? (
              <>
                <div className="assignment-detail-heading">
                  <div className="assignment-detail-heading-main">
                    <h2>{detail.assignment.title}</h2>
                    <div className="assignment-detail-highlights" aria-label="关键指标">
                      <p>完成率 <strong>{detail.assignment.completion_rate}%</strong></p>
                      <p>得分率 <strong>{detail.assignment.average_score == null || !detail.assignment.max_score ? "—" : `${((detail.assignment.average_score / detail.assignment.max_score) * 100).toFixed(1)}%`}</strong></p>
                    </div>
                  </div>
                  <div className="assignment-detail-heading-actions">
                    {gradingRuns[detail.assignment.id] && (
                      <button
                        type="button"
                        className="assignment-manage-button assignment-manage-button-detail assignment-grade-button"
                        onClick={() => void openAssignmentWorkbench(detail.assignment.id)}
                      >
                        {gradingRuns[detail.assignment.id].running || evaluatorRuns[detail.assignment.id]?.running ? "处理中 · 工作台" : "批改工作台"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="assignment-manage-button assignment-manage-button-detail"
                      disabled={archivingId === detail.assignment.id}
                      onClick={() => detail.assignment.status === "archived" ? void setAssignmentStatus(detail.assignment.id, "ungraded") : requestArchive(detail.assignment.id, detail.assignment.title)}
                    >
                      {detail.assignment.status === "archived" ? "取消归档" : "归档作业"}
                    </button>
                  </div>
                </div>
                <AssignmentSummary key={detail.assignment.id} assignmentId={detail.assignment.id} />
                <footer className="assignment-data-note"><span aria-hidden="true">i</span>页面显示数据库中的客观记录；教师结论与高风险操作仍需人工确认。</footer>
              </>
            ) : (
              <div className="assignment-detail-loading">从左侧选择一份作业查看学生数据。</div>
            )}
          </main>
        </div>
      )}

      {archivePrompt && (
        <div
          className="assignment-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !archivingId) setArchivePrompt(null);
          }}
        >
          <div className="assignment-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-assignment-title">
            <h2 id="archive-assignment-title">归档这份作业？</h2>
            <p className="assignment-confirm-lead">{archivePrompt.title}</p>
            <p className="assignment-confirm-copy">归档后当前列表不再显示。记录仍保存在数据库中，可在「已归档」里随时查看。</p>
            <div className="assignment-confirm-actions">
              <button type="button" className="assignment-confirm-secondary" disabled={Boolean(archivingId)} onClick={() => setArchivePrompt(null)}>取消</button>
              <button type="button" className="assignment-confirm-primary" disabled={Boolean(archivingId)} onClick={() => void setAssignmentStatus(archivePrompt.id, "archived")}>
                {archivingId ? "归档中…" : "归档"}
              </button>
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="student-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !importing) setImportOpen(false); }}>
          <div className="student-modal" role="dialog" aria-modal="true" aria-labelledby="import-assignment-title">
            <div className="student-modal-header">
              <div>
                <p>未批改作业</p>
                <h2 id="import-assignment-title">导入作业</h2>
              </div>
              <button type="button" onClick={() => setImportOpen(false)} aria-label="关闭" disabled={importing}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <div className="student-modal-body">
              <div className="assignment-import-form">
                <label>
                  <span>作业标题</span>
                  <input value={importTitle} onChange={(event) => setImportTitle(event.target.value)} placeholder="例如：函数定义域 9月4日" maxLength={240} />
                </label>
                <label>
                  <span>班级</span>
                  <select value={importClassId} onChange={(event) => setImportClassId(event.target.value)} aria-label="选择班级">
                    {classes.length === 0 && <option value="">暂无班级</option>}
                    {classes.map((item) => (
                      <option key={item.id} value={item.id}>{item.name} · {item.student_count} 人</option>
                    ))}
                  </select>
                </label>
                <input
                  ref={importInputRef}
                  type="file"
                  hidden
                  multiple
                  accept=".zip,.pdf,.jpg,.jpeg,.png,.webp,.gif,application/zip,application/pdf,image/*"
                  onChange={(event) => {
                    setImportFiles(Array.from(event.target.files ?? []));
                    setImportResult(null);
                    setImportError(null);
                  }}
                />
                <button type="button" className="student-import-drop" onClick={() => importInputRef.current?.click()}>
                  <span>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4" /><path d="m8 8 4-4 4 4" /><path d="M5 20h14" /></svg>
                  </span>
                  <strong>{importFiles.length ? `已选择 ${importFiles.length} 个文件` : "选择 zip、照片或 PDF"}</strong>
                  <small>Minerva会帮您优化好导入的数据结构</small>
                </button>
                {importError && <p className="assignment-import-error" role="alert">{importError}</p>}
                {importResult && (
                  <div className="assignment-import-summary">
                    <strong>已导入 {importResult.imported_students} 名学生到「{importResult.title}」</strong>
                    {importResult.unmatched.length > 0
                      ? <span>未匹配 {importResult.unmatched.length} 个文件：{importResult.unmatched.map((item) => item.filename).join("、")}</span>
                      : <span>全部文件已匹配。分数仍为空，等待后续批改。</span>}
                  </div>
                )}
              </div>
            </div>
            <div className="student-modal-footer">
              <button className="student-secondary-button" type="button" onClick={() => setImportOpen(false)} disabled={importing}>关闭</button>
              <button className="student-primary-button" type="button" onClick={() => void submitImport()} disabled={importing}>
                {importing ? "导入中…" : "导入作业"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
