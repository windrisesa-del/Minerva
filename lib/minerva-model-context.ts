type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

const SOURCE_KEYS = new Set(["grading_result_id", "assignment_id", "submission_id", "question_id", "answer_attempt_id"]);

/** Lossless dictionary encoding of repeated provenance, never stored in the DB. */
export function compactEvidenceContext(value: unknown): unknown {
  const root = record(value);
  if (!root || "evidence_sources" in root) return value;
  const sources = new Map<string, RecordValue>();
  const conflicts = new Set<string>();
  const refId = (node: RecordValue) => typeof node.grading_result_id === "string"
    && Object.keys(node).every(key => SOURCE_KEYS.has(key)) ? node.grading_result_id : null;
  const scan = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(scan); return; }
    const obj = record(node);
    if (!obj) return;
    const id = refId(obj);
    if (id) {
      const prior = sources.get(id) ?? {};
      if (Object.keys(obj).some(key => key in prior && prior[key] !== obj[key])) conflicts.add(id);
      sources.set(id, { ...prior, ...obj });
    } else Object.values(obj).forEach(scan);
  };
  scan(root);
  for (const id of conflicts) sources.delete(id);
  const project = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(project);
    const obj = record(node);
    if (!obj) return node;
    const id = refId(obj);
    if (id && sources.has(id)) return { grading_result_id: id };
    return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key, project(item)]));
  };
  const projected = project(root) as RecordValue;
  if (!sources.size) return projected;
  const result = { ...projected, evidence_sources: Object.fromEntries(sources) };
  // Small contexts can grow with a dictionary. Retain their original layout.
  return JSON.stringify(result).length < JSON.stringify(root).length ? result : root;
}

export function compactReportContext(value: unknown): unknown {
  const root = record(value);
  if (!root || !Array.isArray(root.students)) return value;
  return compactEvidenceContext({ ...root, students: root.students.map(student => {
    const item = record(student);
    if (!item || !Array.isArray(item.profile_changes)) return student;
    return { ...item, profile_changes: item.profile_changes.map(history => {
      const entry = record(history);
      const after = record(entry?.after);
      // Legacy history without node-level changes retains its full evidence.
      if (!entry || !Array.isArray(after?.changes) || after.changes.length === 0
        || !after.changes.every(change => {
          const node = record(change);
          return node && typeof node.path === "string" && "before" in node && "after" in node;
        })) return history;
      return { id: entry.id, created_at: entry.created_at, after: { changes: after.changes } };
    }) };
  }) });
}
