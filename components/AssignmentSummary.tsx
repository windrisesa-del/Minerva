"use client";

import { useEffect, useState } from "react";
import { MarkdownBody } from "./MarkdownBody";

type Highlight = { text: string; type?: string; student_id?: string };
type Row = { student_id: string; student_name: string; score: number; max_score: number; score_rate: number | null; cells: { question_id: string; score: number; answer_status: string }[] };
type Question = { question_id: string; position: number; max_score: number; mean_score_rate: number | null; full_score_count: number; below_half_count: number; blank_count: number; unknown_answer_status_count: number };
type Narrative = {
  assignment_overview?: Highlight;
  overall: Highlight;
  well_completed_questions?: Highlight[];
  problem_questions?: Highlight[];
  question_highlights?: Highlight[];
  student_highlights: Highlight[];
};
type Report = { id: string; status: string; last_error?: string; statistics: { scope: string; students: Row[]; questions: Question[] }; narrative?: Narrative };
const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;

function indentMarkdown(text: string): string {
  return text.replaceAll("\n", "\n  ");
}

function reportMarkdown(report: Report, names: Map<string, string>): string {
  if (!report.narrative) return "";
  const sections: string[] = [];
  if (report.narrative.assignment_overview) sections.push("### 作业内容", report.narrative.assignment_overview.text);
  sections.push("### 整体完成情况", report.narrative.overall.text);
  if ((report.narrative.well_completed_questions?.length ?? 0) > 0) {
    sections.push(
      "### 完成较好的题目",
      report.narrative.well_completed_questions!.map((item) => `- ${indentMarkdown(item.text)}`).join("\n"),
    );
  }
  const problemQuestions = report.narrative.problem_questions ?? report.narrative.question_highlights ?? [];
  if (problemQuestions.length > 0) sections.push(
    "### 需要重点关注的题目",
    problemQuestions.map((item) => `- ${indentMarkdown(item.text)}`).join("\n"),
  );
  if (report.narrative.student_highlights.length > 0) {
    sections.push(
      "### 值得关注的学生",
      report.narrative.student_highlights.map((item) => (
        `- **${names.get(item.student_id ?? "") || "学生"}：**${indentMarkdown(item.text)}`
      )).join("\n"),
    );
  }
  return sections.join("\n\n");
}

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
  const markdown = report ? reportMarkdown(report, names) : "";
  const scoredStudents = report?.statistics.students.filter((row) => row.score_rate !== null) ?? [];
  const classAverage = scoredStudents.length > 0
    ? scoredStudents.reduce((total, row) => total + (row.score_rate ?? 0), 0) / scoredStudents.length
    : null;
  return <section className="assignment-summary" aria-label="作业报告">
    {error ? <p role="alert">{error}</p> : !report ? <p>等待批改与学生评估完成后自动生成。</p> : <>
      <header className="assignment-report-heading">
        <div>
          <h2>班级作业报告</h2>
          <p className="assignment-summary-scope">{report.statistics.scope}</p>
        </div>
        <dl className="assignment-report-facts">
          <div><dt>学生</dt><dd>{report.statistics.students.length}</dd></div>
          <div><dt>题目</dt><dd>{report.statistics.questions.length}</dd></div>
          <div><dt>平均得分率</dt><dd>{percent(classAverage)}</dd></div>
        </dl>
      </header>
      {report.status === "failed" ? <p className="assignment-report-notice is-error" role="alert">文字总结生成失败：{report.last_error}。统计表仍可查看。</p> : report.status !== "completed" ? <p className="assignment-report-notice" role="status">正在整理作业报告…</p> : null}
      <section className="assignment-report-data" aria-labelledby="assignment-question-statistics">
        <header className="assignment-report-section-heading">
          <div><h3 id="assignment-question-statistics">各题完成情况</h3></div>
          <span>按题目比较班级整体表现</span>
        </header>
        <div className="assignment-report-table-wrap"><table className="assignment-report-table assignment-question-statistics">
        <thead><tr>{["题目", "满分", "平均得分率", "满分人数", "低于一半", "未作答", "作答状态未标注"].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{report.statistics.questions.map(q => <tr key={q.question_id}><td>第{q.position}题</td><td>{q.max_score}</td><td>{percent(q.mean_score_rate)}</td><td>{q.full_score_count}</td><td>{q.below_half_count}</td><td>{q.blank_count}</td><td>{q.unknown_answer_status_count}</td></tr>)}</tbody>
        </table></div>
      </section>
      <section className="assignment-report-data" aria-labelledby="assignment-student-scores">
        <header className="assignment-report-section-heading">
          <div><h3 id="assignment-student-scores">全体学生成绩</h3></div>
          <span>{report.statistics.students.length} 名学生</span>
        </header>
        <div className="assignment-report-table-wrap"><table className="assignment-report-table assignment-student-scores">
        <thead><tr><th>学生</th>{report.statistics.questions.map(q => <th key={q.question_id}>第{q.position}题 / {q.max_score}</th>)}<th>总分</th><th>得分率</th></tr></thead>
        <tbody>{report.statistics.students.map(row => <tr key={row.student_id}><td>{row.student_name}</td>{row.cells.map(cell => <td key={cell.question_id}>{cell.answer_status === "未作答" ? "未作答 · " : ""}{cell.score}</td>)}<td>{row.score}/{row.max_score}</td><td>{percent(row.score_rate)}</td></tr>)}</tbody>
        </table></div>
      </section>
      {markdown && <article className="assignment-report-markdown" aria-label="作业文字报告">
        <header className="assignment-report-section-heading assignment-report-prose-heading">
          <div><h2>分析与观察</h2></div>
          <span>由本次作业数据生成</span>
        </header>
        <MarkdownBody>{markdown}</MarkdownBody>
      </article>}
    </>}
  </section>;
}
