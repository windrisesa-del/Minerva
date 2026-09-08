"use client";

import { useEffect, useState } from "react";

type Highlight = { text: string; type?: string; student_id?: string };
type Row = { student_id: string; student_name: string; score: number; max_score: number; score_rate: number | null; cells: { question_id: string; score: number; answer_status: string }[] };
type Question = { question_id: string; position: number; max_score: number; mean_score_rate: number | null; full_score_count: number; below_half_count: number; blank_count: number; unknown_answer_status_count: number };
type Report = { id: string; status: string; last_error?: string; statistics: { scope: string; students: Row[]; questions: Question[] }; narrative?: { overall: Highlight; question_highlights: Highlight[]; student_highlights: Highlight[] } };
const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;

export function AssignmentSummary({ assignmentId }: { assignmentId: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(`/api/assignment-summary?assignment_id=${encodeURIComponent(assignmentId)}`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "报告读取失败");
        if (!cancelled) { setReport(body.report); setError(""); }
        if (!cancelled && !["completed", "failed"].includes(body.report?.status)) timer = setTimeout(load, 5000);
      } catch (reason) {
        if (!cancelled) { setError(reason instanceof Error ? reason.message : "读取失败"); timer = setTimeout(load, 10000); }
      }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [assignmentId]);
  const names = new Map(report?.statistics.students.map(row => [row.student_id, row.student_name]));
  return <section aria-label="作业报告" style={{ margin: "20px 0", padding: 20, border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-panel)" }}>
    <h3>作业报告</h3>
    {error ? <p role="alert">{error}</p> : !report ? <p>等待批改与学生评估完成后自动生成。</p> : <>
      <p style={{ color: "var(--text-muted)" }}>{report.statistics.scope}</p>
      {report.status === "failed" ? <p role="alert">文字总结生成失败：{report.last_error}。统计表仍可查看。</p> : report.status !== "completed" ? <p role="status">正在整理作业报告…</p> : null}
      {report.narrative && <>
        <p>{report.narrative.overall.text}</p>
        {report.narrative.question_highlights.length > 0 && <div><h4>题目表现</h4>{report.narrative.question_highlights.map((item, index) => <p key={index}>{item.text}</p>)}</div>}
        {report.narrative.student_highlights.length > 0 && <div><h4>值得关注的学生变化</h4>{report.narrative.student_highlights.map((item, index) => <p key={index}><strong>{names.get(item.student_id ?? "") || "学生"}：</strong>{item.text}</p>)}</div>}
      </>}
      <details><summary>查看各题统计</summary><div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderSpacing: "12px 8px", textAlign: "left" }}>
        <thead><tr>{["题目", "满分", "平均得分率", "满分人数", "低于一半", "未作答", "作答状态未标注"].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{report.statistics.questions.map(q => <tr key={q.question_id}><td>第{q.position}题</td><td>{q.max_score}</td><td>{percent(q.mean_score_rate)}</td><td>{q.full_score_count}</td><td>{q.below_half_count}</td><td>{q.blank_count}</td><td>{q.unknown_answer_status_count}</td></tr>)}</tbody>
      </table></div></details>
      <details><summary>查看全体学生成绩</summary><div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderSpacing: "12px 8px", textAlign: "left" }}>
        <thead><tr><th>学生</th>{report.statistics.questions.map(q => <th key={q.question_id}>第{q.position}题 / {q.max_score}</th>)}<th>总分</th><th>得分率</th></tr></thead>
        <tbody>{report.statistics.students.map(row => <tr key={row.student_id}><td>{row.student_name}</td>{row.cells.map(cell => <td key={cell.question_id}>{cell.answer_status === "未作答" ? "未作答 · " : ""}{cell.score}</td>)}<td>{row.score}/{row.max_score}</td><td>{percent(row.score_rate)}</td></tr>)}</tbody>
      </table></div></details>
    </>}
  </section>;
}
