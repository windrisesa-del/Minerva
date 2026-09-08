import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";

export const SUMMARIZER_SESSION_TYPE = "pi-web:minerva-summarizer";
export type SummarizerInfo = { assignmentId: string; reportId: string; title: string };
export const SUMMARIZER_SYSTEM_PROMPT = `你是一名教育数据分析师，负责根据一次作业的完成情况、批改结果及更新后的学生描述，为老师撰写简洁、有依据的作业报告。
报告是老师日常接收学生动态的主要入口；学生描述供老师深入了解时主动查询。常规表现由整体总结承载，只单独报告值得关注的学生变化，不提供教学建议。

Available tools
read_minerva：读取本报告固定版本的数据。resource=statistics 返回整体统计、各题统计、学生成绩表与题目信息；resource=students 按 offset 分页返回学生描述快照与本次变更记录；resource=evidence 指定 student_id 分页读取该学生批改结果。每页默认10条，可调小，必须读完全部学生描述，再按候选重点读取证据。
write_minerva：提交 narrative 保存本次报告。只能写本报告，不能修改成绩、画像或缓冲层。

Guidelines
1. 先读取 statistics，确认统计范围，查看整体与各题表现。数字使用程序结果，不自行估算。作答状态未标注时不得将零分当作空答，没有固定应交名单不得推断未交人数。
2. 从 offset=0 开始分页读取 students。has_more=true 时使用 next_offset 继续，读完全部学生后才能提交。以当前快照为准，历史描述不是本次新发现。
3. 结合题目统计、答案和批改依据，识别完成较好、较困难及表现分化的题目。单题结论限于该题，多题共同支持才概括为本次这类题目。没有统计支持不得声称多数或普遍。
4. 以每名学生自身正常表现为主要参照，筛选显著进步、异常偏离或其他有意义的表现分化。考虑题目内容、难度、考查范围和完整性是否可比，不能仅凭总分或星级升降判断。阅读前后描述、理由和具体作答证据，区分能力变化和判断修正。
5. 不为每人写评语，不凑人数，不因单纯高分低分点名。没有重点学生则返回空数组；多人确实异常时不限制人数。相似现象可在整体总结合并，学生条目保留个体ID和依据。区分全班题目较难与个体偏离正常水平。
6. 有前后证据才报告进步或偏离，历史不足只描述本次事实。不推测开窍、努力、态度、情绪、家庭、抄袭等原因，不将一次异常写成长期退步。
7. 中文撰写整体短段落、题目重点、学生重点，避免重复。每条引用实际数据：stat_refs 使用 overall.字段、questions.题目ID.字段 或 students.学生ID.score/cells/score_rate；批改引用使用 grades 中 id；画像快照引用使用 profile_snapshot_id；变更引用使用 changes 中 id 及 after.changes 中 path。不得编造引用。
8. 调用 write_minerva，narrative 格式如下。两个重点数组允许为空，未用引用为空数组。校验失败按错误修正后重试，以保存成功为完成依据。
{"overall":{"text":"整体情况","stat_refs":[]},"question_highlights":[{"type":"difficulty","question_ids":[],"text":"题目重点","stat_refs":[],"grading_result_refs":[]}],"student_highlights":[{"student_id":"学生ID","type":"progress","text":"值得提醒的变化","question_ids":[],"stat_refs":[],"grading_result_refs":[],"profile_snapshot_refs":[],"profile_change_refs":[{"audit_id":"变更ID","path":"变更路径"}]}]}
题目type仅允许well_completed、difficulty、mixed_performance；学生type仅允许progress、unusual_performance、mixed_performance。进步必须引用画像快照或变更记录。`;

export function createSummarizerExtension(info: SummarizerInfo): InlineExtension {
  return { name: "pi-web-summarizer", factory(pi) {
    const base = (process.env.MINERVA_DATA_API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
    let statisticsRead = false, studentsRead = false, expectedOffset = 0;
    const result = (payload: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: payload, isError });
    pi.registerTool(defineTool({
      name: "read_minerva", label: "读取报告依据", description: "读取固定输入，先统计后分页学生。",
      parameters: Type.Object({ resource: Type.Union([Type.Literal("statistics"), Type.Literal("students"), Type.Literal("evidence")]), student_id: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })) }),
      async execute(_id, params) {
        if (!["statistics", "students", "evidence"].includes(params.resource)) return result({ error: "资源不允许" }, true);
        const offset = params.offset ?? 0;
        if (params.resource === "students" && offset !== expectedOffset && offset !== 0) return result({ error: `请从 offset=${expectedOffset} 继续，不能跳页` }, true);
        const query = new URLSearchParams({ resource: params.resource, offset: String(offset), limit: String(params.limit ?? 10) });
        if (params.student_id) query.set("student_id", params.student_id);
        const response = await fetch(`${base}/api/summary/${encodeURIComponent(info.reportId)}/input?${query}`, { cache: "no-store" });
        const payload = await response.json();
        if (response.ok) {
          if (params.resource === "statistics") statisticsRead = true;
          else if (params.resource === "students") { studentsRead = !payload.has_more; expectedOffset = payload.next_offset ?? 0; }
        }
        return result(payload, !response.ok);
      },
    }));
    pi.registerTool(defineTool({
      name: "write_minerva", label: "保存作业报告", description: "完整读取全部学生后保存报告。",
      parameters: Type.Object({ narrative: Type.Object({ overall: Type.Any(), question_highlights: Type.Array(Type.Any()), student_highlights: Type.Array(Type.Any()) }, { additionalProperties: false }) }),
      async execute(_id, params) {
        if (!statisticsRead || !studentsRead) return result({ error: "必须先读取统计并分页读完全部学生" }, true);
        const response = await fetch(`${base}/api/summary/${encodeURIComponent(info.reportId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ narrative: params.narrative }) });
        return result(await response.json(), !response.ok);
      },
    }));
  } };
}
