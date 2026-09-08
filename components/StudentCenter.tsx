"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  STUDENT_FIELD_LABELS,
  type StudentInput,
  type StudentRecord,
  type StudentStoreSnapshot,
} from "@/lib/student-types";

type AddMode = "manual" | "import";

type EvidenceRef = Record<string, string>;
type KnowledgePointProfile = {
  knowledge_name: string;
  mastery_level: number | null;
  mastery_reason: string;
  mastered_parts: string[];
  unmastered_parts: string[];
  mastery_boundaries: string[];
  common_errors: string[];
  evidence_refs: EvidenceRef[];
};
type StudentProfile = {
  knowledge_profile: { knowledge_points: Record<string, KnowledgePointProfile> };
  problem_solving_and_learning_profile: {
    strong_problem_types: string[];
    difficult_problem_types: string[];
    reasoning_characteristics: string[];
    learning_strategies_and_habits: string[];
    evidence_refs: EvidenceRef[];
  };
  learning_trajectory: {
    recent_progress: string[];
    recent_regressions: string[];
    emerging_problems: string[];
    developing_abilities: string[];
    evidence_refs: EvidenceRef[];
  };
};
type BufferItem = {
  candidate_id?: string;
  claim?: string;
  status?: string;
  target?: { profile_section?: string; knowledge_id?: string; attribute?: string };
  evidence?: Array<{ relationship?: string }>;
  assessment?: { confidence?: number; reason?: string; missing_evidence?: string[] };
};

const PROBLEM_FIELDS = [
  { key: "strong_problem_types", label: "擅长的问题类型" },
  { key: "difficult_problem_types", label: "困难的问题类型" },
  { key: "reasoning_characteristics", label: "思考 / 推理特征" },
  { key: "learning_strategies_and_habits", label: "学习策略与习惯" },
] as const;
const TRAJECTORY_FIELDS = [
  { key: "recent_progress", label: "最近进步" },
  { key: "recent_regressions", label: "最近退步" },
  { key: "emerging_problems", label: "新出现的问题" },
  { key: "developing_abilities", label: "正在形成的能力" },
] as const;
const KNOWLEDGE_FIELDS = [
  { key: "mastered_parts", label: "已掌握部分" },
  { key: "unmastered_parts", label: "未掌握部分" },
  { key: "mastery_boundaries", label: "掌握边界" },
  { key: "common_errors", label: "常见错误" },
] as const;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function emptyStudentProfile(): StudentProfile {
  return {
    knowledge_profile: { knowledge_points: {} },
    problem_solving_and_learning_profile: {
      strong_problem_types: [],
      difficult_problem_types: [],
      reasoning_characteristics: [],
      learning_strategies_and_habits: [],
      evidence_refs: [],
    },
    learning_trajectory: {
      recent_progress: [],
      recent_regressions: [],
      emerging_problems: [],
      developing_abilities: [],
      evidence_refs: [],
    },
  };
}

function normalizeStudentProfile(value: unknown): StudentProfile {
  const empty = emptyStudentProfile();
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const root = value as Record<string, unknown>;
  const knowledge = root.knowledge_profile && typeof root.knowledge_profile === "object"
    ? root.knowledge_profile as Record<string, unknown>
    : {};
  const rawPoints = knowledge.knowledge_points && typeof knowledge.knowledge_points === "object"
    ? knowledge.knowledge_points as Record<string, unknown>
    : {};
  for (const [knowledgeId, rawPoint] of Object.entries(rawPoints)) {
    if (!rawPoint || typeof rawPoint !== "object" || Array.isArray(rawPoint)) continue;
    const point = rawPoint as Record<string, unknown>;
    const mastery = typeof point.mastery_level === "number" && point.mastery_level >= 1 && point.mastery_level <= 5
      ? Math.floor(point.mastery_level)
      : null;
    empty.knowledge_profile.knowledge_points[knowledgeId] = {
      knowledge_name: String(point.knowledge_name || knowledgeId),
      mastery_level: mastery,
      mastery_reason: String(point.mastery_reason || ""),
      mastered_parts: stringList(point.mastered_parts),
      unmastered_parts: stringList(point.unmastered_parts),
      mastery_boundaries: stringList(point.mastery_boundaries),
      common_errors: stringList(point.common_errors),
      evidence_refs: Array.isArray(point.evidence_refs) ? point.evidence_refs as EvidenceRef[] : [],
    };
  }
  const problem = root.problem_solving_and_learning_profile && typeof root.problem_solving_and_learning_profile === "object"
    ? root.problem_solving_and_learning_profile as Record<string, unknown>
    : {};
  for (const field of PROBLEM_FIELDS) empty.problem_solving_and_learning_profile[field.key] = stringList(problem[field.key]);
  empty.problem_solving_and_learning_profile.evidence_refs = Array.isArray(problem.evidence_refs) ? problem.evidence_refs as EvidenceRef[] : [];
  const trajectory = root.learning_trajectory && typeof root.learning_trajectory === "object"
    ? root.learning_trajectory as Record<string, unknown>
    : {};
  for (const field of TRAJECTORY_FIELDS) empty.learning_trajectory[field.key] = stringList(trajectory[field.key]);
  empty.learning_trajectory.evidence_refs = Array.isArray(trajectory.evidence_refs) ? trajectory.evidence_refs as EvidenceRef[] : [];
  return empty;
}

function lines(value: string) {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

const emptyForm: StudentInput = {
  name: "",
  studentNumber: "",
  className: "",
  groupName: "",
  guardianName: "",
  guardianPhone: "",
  email: "",
  notes: "",
  portrait: "",
};

function formatDate(value: string, withTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

function studentInitial(name: string) {
  return name.trim().slice(0, 1).toUpperCase() || "学";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field.trim());
      field = "";
    } else if (char === "\n") {
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function csvToStudents(text: string): StudentInput[] {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("CSV 至少需要表头和一行学生数据");
  const aliases: Record<string, keyof StudentInput> = {
    姓名: "name", name: "name",
    学号: "studentNumber", studentnumber: "studentNumber", studentid: "studentNumber",
    班级: "className", classname: "className", class: "className",
    分组: "groupName", groupname: "groupName", group: "groupName",
    监护人: "guardianName", guardian: "guardianName", guardianname: "guardianName",
    联系电话: "guardianPhone", 手机: "guardianPhone", phone: "guardianPhone", guardianphone: "guardianPhone",
    邮箱: "email", email: "email",
    备注: "notes", notes: "notes",
  };
  const fields = rows[0].map((header) => aliases[header.trim().toLowerCase()] ?? null);
  if (!fields.includes("name")) throw new Error("CSV 表头必须包含“姓名”列");
  return rows.slice(1).map((values) => {
    const student: StudentInput = { name: "" };
    fields.forEach((field, index) => {
      if (field) student[field] = values[index] ?? "";
    });
    return student;
  }).filter((student) => student.name?.trim());
}

async function resizePortrait(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  if (file.size > 8 * 1024 * 1024) throw new Error("原始头像不能超过 8MB");
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("读取头像失败"));
    reader.readAsDataURL(file);
  });
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("无法解析头像"));
    element.src = source;
  });
  const size = 720;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法处理头像");
  const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
  return canvas.toDataURL("image/jpeg", 0.84);
}

function Portrait({ student, large = false }: { student: Pick<StudentRecord, "name" | "portrait">; large?: boolean }) {
  return (
    <div className={`student-portrait${large ? " is-large" : ""}`} aria-label={`${student.name}的头像`}>
      {student.portrait ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={student.portrait} alt="" />
      ) : (
        <span>{studentInitial(student.name)}</span>
      )}
    </div>
  );
}

function Icon({ name, size = 16 }: { name: "students" | "history" | "plus" | "search" | "back" | "edit" | "upload" | "close"; size?: number }) {
  const paths = {
    students: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.5-3.2 2.3-5 5.5-5s5 1.8 5.5 5" /><circle cx="17" cy="9" r="2.2" /><path d="M15.5 14.5c2.9-.4 4.6 1 5 3.5" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    back: <><path d="m15 18-6-6 6-6" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></>,
    upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M5 20h14" /></>,
    close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function StudentForm({
  value,
  onChange,
  portraitBusy,
  onPortrait,
}: {
  value: StudentInput;
  onChange: (value: StudentInput) => void;
  portraitBusy: boolean;
  onPortrait: (file: File) => void;
}) {
  const set = (field: keyof StudentInput, next: string) => onChange({ ...value, [field]: next });
  return (
    <div className="student-form-grid">
      <div className="student-photo-field">
        <div className="student-photo-preview">
          {value.portrait ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value.portrait} alt="头像预览" />
          ) : <span>{studentInitial(value.name ?? "")}</span>}
        </div>
        <label className="student-photo-upload">
          <Icon name="upload" size={15} />
          {portraitBusy ? "处理中…" : "选择头像"}
          <input
            type="file"
            accept="image/*"
            disabled={portraitBusy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onPortrait(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        <p>头像仅保存在本机。</p>
      </div>
      <div className="student-fields">
        <label><span>姓名 *</span><input value={value.name ?? ""} onChange={(event) => set("name", event.target.value)} /></label>
        <label><span>学号</span><input value={value.studentNumber ?? ""} onChange={(event) => set("studentNumber", event.target.value)} /></label>
        <label><span>班级</span><input value={value.className ?? ""} onChange={(event) => set("className", event.target.value)} /></label>
        <label><span>分组</span><input value={value.groupName ?? ""} onChange={(event) => set("groupName", event.target.value)} /></label>
        <label><span>监护人</span><input value={value.guardianName ?? ""} onChange={(event) => set("guardianName", event.target.value)} /></label>
        <label><span>联系电话</span><input value={value.guardianPhone ?? ""} onChange={(event) => set("guardianPhone", event.target.value)} /></label>
        <label className="is-wide"><span>邮箱</span><input type="email" value={value.email ?? ""} onChange={(event) => set("email", event.target.value)} /></label>
        <label className="is-wide"><span>备注</span><textarea rows={4} value={value.notes ?? ""} onChange={(event) => set("notes", event.target.value)} /></label>
      </div>
    </div>
  );
}

export function StudentCenter({ onInitialReady }: { onInitialReady?: () => void }) {
  const [snapshot, setSnapshot] = useState<StudentStoreSnapshot>({ version: 1, students: [], changes: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [classFilter, setClassFilter] = useState("all");
  const [groupFilter, setGroupFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<StudentInput>(emptyForm);
  const [portraitBusy, setPortraitBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>("manual");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [importStudents, setImportStudents] = useState<StudentInput[]>([]);
  const [importName, setImportName] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);
  const [observation, setObservation] = useState<{ description: StudentProfile; buffer: BufferItem[]; teacherFields: string[] } | null>(null);
  const [profileDraft, setProfileDraft] = useState<StudentProfile>(() => emptyStudentProfile());
  const [observationSaving, setObservationSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await requestJson<StudentStoreSnapshot>("/api/students"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setObservation(null);
      setProfileDraft(emptyStudentProfile());
      return;
    }
    let cancelled = false;
    void requestJson<{
      description?: { description?: Record<string, unknown>; teacher_fields?: string[] };
      evidence_buffer?: { items?: BufferItem[] };
    }>(`/api/student-observations?studentId=${encodeURIComponent(selectedId)}`).then((body) => {
      if (cancelled) return;
      const description = normalizeStudentProfile(body.description?.description);
      const buffer = body.evidence_buffer?.items ?? [];
      const teacherFields = body.description?.teacher_fields ?? [];
      setObservation({ description, buffer, teacherFields });
      setProfileDraft(description);
    }).catch(() => {
      if (cancelled) return;
      const description = emptyStudentProfile();
      setObservation({ description, buffer: [], teacherFields: [] });
      setProfileDraft(description);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  const initialReadyReportedRef = useRef(false);
  useEffect(() => {
    if (loading || initialReadyReportedRef.current) return;
    initialReadyReportedRef.current = true;
    onInitialReady?.();
  }, [loading, onInitialReady]);

  const selected = snapshot.students.find((student) => student.id === selectedId) ?? null;
  const classes = useMemo(() => [...new Set(snapshot.students.map((student) => student.className).filter(Boolean))].sort(), [snapshot.students]);
  const groups = useMemo(() => [...new Set(snapshot.students.map((student) => student.groupName).filter(Boolean))].sort(), [snapshot.students]);
  const visibleStudents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return snapshot.students.filter((student) => {
      if (classFilter !== "all" && student.className !== classFilter) return false;
      if (groupFilter !== "all" && student.groupName !== groupFilter) return false;
      if (!needle) return true;
      return [student.name, student.studentNumber, student.className, student.groupName]
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [classFilter, groupFilter, query, snapshot.students]);
  const visibleChanges = useMemo(() => {
    const needle = historyQuery.trim().toLowerCase();
    if (!needle) return snapshot.changes;
    return snapshot.changes.filter((change) => [
      change.studentName,
      STUDENT_FIELD_LABELS[change.field],
      change.actor,
      change.oldValue,
      change.newValue,
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [historyQuery, snapshot.changes]);

  const handlePortrait = async (file: File) => {
    setPortraitBusy(true);
    setError(null);
    try {
      const portrait = await resizePortrait(file);
      setForm((current) => ({ ...current, portrait }));
    } catch (portraitError) {
      setError(portraitError instanceof Error ? portraitError.message : String(portraitError));
    } finally {
      setPortraitBusy(false);
    }
  };

  const openAdd = () => {
    setForm(emptyForm);
    setImportStudents([]);
    setImportName("");
    setAddMode("manual");
    setError(null);
    setAddOpen(true);
  };

  const saveNew = async () => {
    const students = addMode === "manual" ? [form] : importStudents;
    if (students.length === 0) {
      setError(addMode === "manual" ? "请填写学生姓名" : "请先选择 CSV 文件");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await requestJson<{ students: StudentRecord[] }>("/api/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ students, source: addMode === "import" ? "csv_import" : "manual" }),
      });
      setAddOpen(false);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await requestJson<{ student: StudentRecord }>(`/api/students/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      setEditing(false);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const startEdit = () => {
    if (!selected) return;
    setForm({
      name: selected.name,
      studentNumber: selected.studentNumber,
      className: selected.className,
      groupName: selected.groupName,
      guardianName: selected.guardianName,
      guardianPhone: selected.guardianPhone,
      email: selected.email,
      notes: selected.notes,
      portrait: selected.portrait,
    });
    setEditing(true);
    setError(null);
  };

  const updateKnowledgePoint = (knowledgeId: string, update: Partial<KnowledgePointProfile>) => {
    setProfileDraft((current) => ({
      ...current,
      knowledge_profile: {
        knowledge_points: {
          ...current.knowledge_profile.knowledge_points,
          [knowledgeId]: {
            ...current.knowledge_profile.knowledge_points[knowledgeId],
            ...update,
          },
        },
      },
    }));
  };

  const updateProblemField = (
    key: (typeof PROBLEM_FIELDS)[number]["key"],
    value: string,
  ) => {
    setProfileDraft((current) => ({
      ...current,
      problem_solving_and_learning_profile: {
        ...current.problem_solving_and_learning_profile,
        [key]: lines(value),
      },
    }));
  };

  const updateTrajectoryField = (
    key: (typeof TRAJECTORY_FIELDS)[number]["key"],
    value: string,
  ) => {
    setProfileDraft((current) => ({
      ...current,
      learning_trajectory: {
        ...current.learning_trajectory,
        [key]: lines(value),
      },
    }));
  };

  return (
    <section className="student-center" aria-label="学生中心">
      <header className="student-center-header">
        <div className="student-center-title">
          <h1>{selected ? selected.name : "学生中心"}</h1>
        </div>
        <div className="student-center-actions">
          {selected ? (
            <>
              <button className="student-secondary-button" type="button" onClick={() => { setSelectedId(null); setEditing(false); }}><Icon name="back" />返回学生中心</button>
              {!editing && <button className="student-primary-button" type="button" onClick={startEdit}><Icon name="edit" />编辑资料</button>}
            </>
          ) : (
            <>
              <button className="student-secondary-button" type="button" onClick={() => setHistoryOpen(true)}><Icon name="history" />更改记录</button>
              <button className="student-primary-button" type="button" onClick={openAdd}><Icon name="plus" />添加学生</button>
            </>
          )}
        </div>
      </header>

      {error && <div className="student-error" role="alert">{error}<button type="button" onClick={() => setError(null)} aria-label="关闭"><Icon name="close" size={14} /></button></div>}

      {selected ? (
        <div className="student-detail-shell">
          {editing ? (
            <div className="student-editor-card">
              <StudentForm value={form} onChange={setForm} portraitBusy={portraitBusy} onPortrait={(file) => void handlePortrait(file)} />
              <div className="student-form-actions">
                <button className="student-secondary-button" type="button" onClick={() => setEditing(false)} disabled={saving}>取消</button>
                <button className="student-primary-button" type="button" onClick={() => void saveEdit()} disabled={saving || portraitBusy}>{saving ? "保存中…" : "保存更改"}</button>
              </div>
            </div>
          ) : (
            <>
            <div className="student-profile">
              <aside className="student-profile-identity">
                <Portrait student={selected} large />
                <h2>{selected.name}</h2>
                <p>{[selected.className, selected.groupName].filter(Boolean).join(" · ") || "尚未填写班级与分组"}</p>
                <span>最近更新：{formatDate(selected.updatedAt)}</span>
              </aside>
              <div className="student-profile-sections">
                <section>
                  <h3>基础资料</h3>
                  <dl>
                    <div><dt>学号</dt><dd>{selected.studentNumber || "未填写"}</dd></div>
                    <div><dt>班级</dt><dd>{selected.className || "未填写"}</dd></div>
                    <div><dt>分组</dt><dd>{selected.groupName || "未填写"}</dd></div>
                    <div><dt>邮箱</dt><dd>{selected.email || "未填写"}</dd></div>
                  </dl>
                </section>
                <section>
                  <h3>联系信息</h3>
                  <dl>
                    <div><dt>监护人</dt><dd>{selected.guardianName || "未填写"}</dd></div>
                    <div><dt>联系电话</dt><dd>{selected.guardianPhone || "未填写"}</dd></div>
                  </dl>
                </section>
                <section className="is-wide">
                  <h3>教师备注</h3>
                  <p className="student-notes">{selected.notes || "尚未填写备注。"}</p>
                </section>
              </div>
            </div>
            <div className="student-observation">
              <div className="student-observation-header">
                <div>
                  <p className="student-observation-eyebrow">LEARNING OBSERVATION</p>
                  <h3>学习观察</h3>
                </div>
                <button
                  className="student-primary-button"
                  type="button"
                  disabled={observationSaving}
                  onClick={() => {
                    const fields: Record<string, unknown> = {};
                    for (const key of ["knowledge_profile", "problem_solving_and_learning_profile", "learning_trajectory"] as const) {
                      if (JSON.stringify(profileDraft[key]) !== JSON.stringify(observation?.description[key])) {
                        fields[key] = profileDraft[key];
                      }
                    }
                    if (Object.keys(fields).length === 0) return;
                    setObservationSaving(true);
                    void requestJson("/api/student-observations", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ studentId: selected.id, fields }),
                    }).then(() => {
                      setObservation((current) => ({
                        description: profileDraft,
                        buffer: current?.buffer ?? [],
                        teacherFields: [...new Set([...(current?.teacherFields ?? []), ...Object.keys(fields)])],
                      }));
                    }).catch((reason) => setError(reason instanceof Error ? reason.message : "学习观察保存失败"))
                      .finally(() => setObservationSaving(false));
                  }}
                >
                  {observationSaving ? "保存中…" : "保存观察"}
                </button>
              </div>
              <div className="student-observation-grid">
                <div className="student-knowledge is-wide">
                  <span>1. Knowledge Profile · 知识掌握情况{observation?.teacherFields.includes("knowledge_profile") ? " · 老师手改" : ""}</span>
                  {Object.entries(profileDraft.knowledge_profile.knowledge_points).length ? (
                    <div className="student-knowledge-points">
                      {Object.entries(profileDraft.knowledge_profile.knowledge_points).map(([knowledgeId, point]) => (
                        <article className="student-knowledge-point" key={knowledgeId}>
                          <div className="student-knowledge-point-title">
                            <div><strong>{point.knowledge_name}</strong><small>{knowledgeId}</small></div>
                            <div className="student-mastery-stars" aria-label={`${point.knowledge_name}掌握程度`}>
                              {[1, 2, 3, 4, 5].map((star) => (
                                <button
                                  key={star}
                                  type="button"
                                  className={star <= (point.mastery_level ?? 0) ? "is-active" : undefined}
                                  aria-label={`${star} 星`}
                                  onClick={() => updateKnowledgePoint(knowledgeId, { mastery_level: star })}
                                >★</button>
                              ))}
                              <button type="button" className="student-mastery-clear" onClick={() => updateKnowledgePoint(knowledgeId, { mastery_level: null })}>未评估</button>
                            </div>
                          </div>
                          <label className="is-wide">
                            <span>掌握程度依据</span>
                            <textarea value={point.mastery_reason} onChange={(event) => updateKnowledgePoint(knowledgeId, { mastery_reason: event.target.value })} placeholder="暂无依据" rows={2} />
                          </label>
                          <div className="student-knowledge-grid">
                            {KNOWLEDGE_FIELDS.map((field) => (
                              <label key={field.key}>
                                <span>{field.label}</span>
                                <textarea value={point[field.key].join("\n")} onChange={(event) => updateKnowledgePoint(knowledgeId, { [field.key]: lines(event.target.value) })} placeholder="暂无观察" rows={3} />
                              </label>
                            ))}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : <p className="student-observation-empty">尚无经过评估的知识点。</p>}
                </div>
                <section className="student-profile-observation-section is-wide">
                  <h4>2. Problem-Solving &amp; Learning Profile{observation?.teacherFields.includes("problem_solving_and_learning_profile") ? " · 老师手改" : ""}</h4>
                  <div className="student-observation-grid">
                    {PROBLEM_FIELDS.map((field) => (
                      <label key={field.key}>
                        <span>{field.label}</span>
                        <textarea value={profileDraft.problem_solving_and_learning_profile[field.key].join("\n")} onChange={(event) => updateProblemField(field.key, event.target.value)} placeholder="暂无观察" rows={4} />
                      </label>
                    ))}
                  </div>
                </section>
                <section className="student-profile-observation-section is-wide">
                  <h4>3. Learning Trajectory · 学习变化{observation?.teacherFields.includes("learning_trajectory") ? " · 老师手改" : ""}</h4>
                  <div className="student-observation-grid">
                    {TRAJECTORY_FIELDS.map((field) => (
                      <label key={field.key}>
                        <span>{field.label}</span>
                        <textarea value={profileDraft.learning_trajectory[field.key].join("\n")} onChange={(event) => updateTrajectoryField(field.key, event.target.value)} placeholder="暂无观察" rows={4} />
                      </label>
                    ))}
                  </div>
                </section>
              </div>
              <section className="student-observation-buffer">
                <h4>Evidence Buffer · 待验证判断</h4>
                {observation?.buffer.length ? (
                  <ul>
                    {observation.buffer.map((item, index) => (
                      <li key={item.candidate_id ?? `candidate-${index}`}>
                        <strong>{item.claim}</strong>
                        <span>{item.assessment?.reason || "等待更多证据"}</span>
                        <small>
                          置信度 {Math.round((item.assessment?.confidence ?? 0) * 100)}%
                          {item.evidence?.length ? ` · ${item.evidence.length} 条证据` : ""}
                          {item.status === "contradicted" ? " · 存在反证" : ""}
                        </small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>暂无待观察信号。</p>
                )}
              </section>
            </div>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="student-toolbar">
            <label className="student-search"><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名、学号、班级或分组" /></label>
            <select value={classFilter} onChange={(event) => setClassFilter(event.target.value)} aria-label="筛选班级"><option value="all">全部班级</option>{classes.map((value) => <option key={value} value={value}>{value}</option>)}</select>
            <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)} aria-label="筛选分组"><option value="all">全部分组</option>{groups.map((value) => <option key={value} value={value}>{value}</option>)}</select>
            <span>{visibleStudents.length} 名学生</span>
          </div>
          <div className="student-card-scroll">
            {loading ? (
              <div className="student-empty"><div className="student-empty-mark"><Icon name="students" size={26} /></div><h2>正在载入学生档案</h2></div>
            ) : visibleStudents.length > 0 ? (
              <div className="student-card-grid">
                {visibleStudents.map((student, index) => (
                  <button
                    key={student.id}
                    type="button"
                    className="student-card"
                    style={{ "--student-index": index } as React.CSSProperties}
                    onClick={() => { setSelectedId(student.id); setEditing(false); }}
                  >
                    <Portrait student={student} />
                    <div className="student-card-copy">
                      <h2>{student.name}</h2>
                      <p>{student.studentNumber ? `学号 ${student.studentNumber}` : "学号未填写"}</p>
                      <div><span>{student.className || "班级未填写"}</span>{student.groupName && <span>{student.groupName}</span>}</div>
                      <time dateTime={student.updatedAt}>更新于 {formatDate(student.updatedAt)}</time>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="student-empty">
                <div className="student-empty-mark"><Icon name="students" size={28} /></div>
                <h2>{snapshot.students.length === 0 ? "从第一名学生开始" : "没有符合条件的学生"}</h2>
                <p>{snapshot.students.length === 0 ? "手动添加学生，或一次导入现有的 CSV 名单。" : "可以调整关键词、班级或分组筛选。"}</p>
                {snapshot.students.length === 0 && <button className="student-primary-button" type="button" onClick={openAdd}><Icon name="plus" />添加学生</button>}
              </div>
            )}
          </div>
        </>
      )}

      {addOpen && (
        <div className="student-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setAddOpen(false); }}>
          <div className="student-modal" role="dialog" aria-modal="true" aria-labelledby="add-student-title">
            <div className="student-modal-header"><div><p>学生档案</p><h2 id="add-student-title">添加学生</h2></div><button type="button" onClick={() => setAddOpen(false)} aria-label="关闭" disabled={saving}><Icon name="close" /></button></div>
            <div className="student-add-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={addMode === "manual"} onClick={() => setAddMode("manual")}>手动添加</button>
              <button type="button" role="tab" aria-selected={addMode === "import"} onClick={() => setAddMode("import")}>CSV 批量导入</button>
            </div>
            <div className="student-modal-body">
              {addMode === "manual" ? (
                <StudentForm value={form} onChange={setForm} portraitBusy={portraitBusy} onPortrait={(file) => void handlePortrait(file)} />
              ) : (
                <div className="student-import-panel">
                  <input
                    ref={importInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      setError(null);
                      void file.text().then((text) => {
                        const parsed = csvToStudents(text);
                        setImportStudents(parsed);
                        setImportName(file.name);
                      }).catch((importError) => setError(importError instanceof Error ? importError.message : String(importError)));
                    }}
                  />
                  <button type="button" className="student-import-drop" onClick={() => importInputRef.current?.click()}>
                    <span><Icon name="upload" size={23} /></span>
                    <strong>{importName || "选择 CSV 学生名单"}</strong>
                    <small>支持：姓名、学号、班级、分组、监护人、联系电话、邮箱、备注</small>
                  </button>
                  {importStudents.length > 0 && <div className="student-import-summary"><strong>已识别 {importStudents.length} 名学生</strong><span>导入后仍可逐个补充头像和详细资料。</span></div>}
                </div>
              )}
            </div>
            <div className="student-modal-footer"><button className="student-secondary-button" type="button" onClick={() => setAddOpen(false)} disabled={saving}>取消</button><button className="student-primary-button" type="button" onClick={() => void saveNew()} disabled={saving || portraitBusy}>{saving ? "保存中…" : addMode === "manual" ? "添加学生" : importStudents.length ? `导入 ${importStudents.length} 名学生` : "导入学生"}</button></div>
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="student-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryOpen(false); }}>
          <aside className="student-history-drawer" role="dialog" aria-modal="true" aria-labelledby="student-history-title">
            <div className="student-modal-header"><div><p>资料审计</p><h2 id="student-history-title">更改记录</h2></div><button type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭"><Icon name="close" /></button></div>
            <label className="student-history-search"><Icon name="search" /><input value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} placeholder="搜索学生、字段或操作人" /></label>
            <div className="student-history-list">
              {visibleChanges.length > 0 ? visibleChanges.map((change) => (
                <article key={change.id} className="student-history-entry">
                  <div><strong>{change.studentName}</strong><time dateTime={change.timestamp}>{formatDate(change.timestamp, true)}</time></div>
                  <p>修改“{STUDENT_FIELD_LABELS[change.field]}”</p>
                  <div className="student-change-values"><span>{change.oldValue}</span><b>→</b><span>{change.newValue}</span></div>
                  <footer>{change.actor} · {change.source === "csv_import" ? "CSV 导入" : "手动编辑"}</footer>
                </article>
              )) : <div className="student-history-empty"><Icon name="history" size={24} /><strong>暂无更改记录</strong><span>添加或编辑学生资料后会显示在这里。</span></div>}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
