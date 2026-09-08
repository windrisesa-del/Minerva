"""Frozen evaluator inputs and deterministic assignment reporting."""
from copy import deepcopy
from hashlib import sha256
import json
from uuid import UUID

from sqlalchemy import select

from .models import Assignment, AssignmentSummary, EvaluationReceipt, Student


def collect_pages(session, **query):
    from .minerva_tools import read_minerva
    records, offset = [], 0
    while True:
        page = read_minerva(session, **query, limit=200, offset=offset)
        records.extend(page["records"])
        if not page.get("has_more"):
            return records
        next_offset = page.get("next_offset")
        if not isinstance(next_offset, int) or next_offset <= offset:
            raise ValueError("数据分页未前进")
        offset = next_offset


def complete_evaluation(session, assignment_id, student_id, description):
    from .minerva_tools import _json_value
    grades = collect_pages(session, resource="grading_results", assignment_id=assignment_id, student_id=student_id, grader_type="ai")
    if not grades:
        raise ValueError("评估完成必须有当前提交的批改结果")
    submission_id = UUID(grades[0]["submission_id"])
    history = collect_pages(session, resource="observation_history", assignment_id=assignment_id, student_id=student_id)
    history = [{"id": h["id"], "created_at": h["created_at"], "before": {"description": (h.get("before") or {}).get("description")},
                "after": {"description": (h.get("after") or {}).get("description"),
                          "changes": [c for c in (h.get("after") or {}).get("changes", []) if c["path"].startswith("/description/")]}}
               for h in history]
    student_name = session.get(Student, student_id).name
    receipt = session.get(EvaluationReceipt, (assignment_id, student_id))
    if receipt is None:
        receipt = EvaluationReceipt(assignment_id=assignment_id, student_id=student_id, submission_id=submission_id)
        session.add(receipt)
    receipt.submission_id = submission_id
    receipt.snapshot = _json_value({"student_id": str(student_id), "student_name": student_name,
        "profile_snapshot_id": f"{assignment_id}:{student_id}", "description": deepcopy(description),
        "changes": history, "grades": grades})


def build_statistics(students, items):
    question_stats, student_rows = [], []
    for student in students:
        # Most recent AI result per question; duplicates never inflate totals.
        grades = {}
        for grade in student["grades"]:
            grades.setdefault(grade["question_id"], grade)
        cells = []
        for item in items:
            grade = grades.get(item["question_id"])
            if grade is None or grade["score"] is None:
                raise ValueError("批改缺失，不能生成完整报告")
            score, maximum = float(grade["score"]), float(item["max_score"])
            if not 0 <= score <= maximum:
                raise ValueError("批改分数超出范围")
            # Absence of an explicit empty-answer marker is not proof of completion.
            answer = grade.get("answer_payload") or {}
            status = answer.get("status") if isinstance(answer, dict) else None
            empty = True if status == "blank" else False if status == "answered" else answer.get("is_blank") if isinstance(answer, dict) else None
            cells.append({"question_id": item["question_id"], "score": score, "max_score": maximum,
                          "answer_status": "未作答" if empty is True else "已作答" if empty is False else "未标注"})
        total, maximum = sum(c["score"] for c in cells), sum(c["max_score"] for c in cells)
        student_rows.append({"student_id": student["student_id"], "student_name": student["student_name"],
            "submission_status": "已提交", "cells": cells, "score": total, "max_score": maximum,
            "score_rate": total / maximum if maximum else None})
    for index, item in enumerate(items):
        cells = [row["cells"][index] for row in student_rows]
        maximum = float(item["max_score"])
        question_stats.append({"question_id": item["question_id"], "position": item["position"],
            "max_score": maximum, "student_count": len(cells),
            "mean_score_rate": sum(c["score"] for c in cells) / (len(cells) * maximum) if cells and maximum else None,
            "full_score_count": sum(c["score"] == maximum for c in cells),
            "below_half_count": sum(c["score"] < maximum / 2 for c in cells),
            "blank_count": sum(c["answer_status"] == "未作答" for c in cells),
            "unknown_answer_status_count": sum(c["answer_status"] == "未标注" for c in cells)})
    total_max = sum(r["max_score"] for r in student_rows)
    return {"scope": "本次有效已提交并完成评估的作业；无固定应交名单，不推断未交人数", "overall": {
        "submitted_count": len(student_rows), "mean_score": sum(r["score"] for r in student_rows) / len(student_rows) if student_rows else None,
        "mean_score_rate": sum(r["score"] for r in student_rows) / total_max if total_max else None},
        "questions": question_stats, "students": student_rows}


def prepare_summary(session, assignment_id):
    from .minerva_tools import read_minerva, _json_value
    assignment = session.get(Assignment, assignment_id)
    if assignment is None or assignment.status != "graded":
        raise ValueError("作业尚未完成批改")
    students = collect_pages(session, resource="graded_students", assignment_id=assignment_id)
    if not students:
        raise ValueError("没有可总结的学生")
    snapshots = []
    for student in students:
        receipt = session.get(EvaluationReceipt, (assignment_id, UUID(student["student_id"])))
        if receipt is None or str(receipt.submission_id) != student["submission_id"]:
            raise ValueError("等待全部学生明确完成 Evaluator")
        current = collect_pages(session, resource="grading_results", assignment_id=assignment_id, student_id=UUID(student["student_id"]), grader_type="ai")
        if current != receipt.snapshot["grades"]:
            raise ValueError("批改版本已改变，需完成对应版本的评估")
        snapshots.append(deepcopy(receipt.snapshot))
    items = read_minerva(session, resource="assignment_items", assignment_id=assignment_id)["records"]
    snapshot = _json_value({"title": assignment.title, "students": snapshots, "items": items,
                           "statistics": build_statistics(snapshots, items)})
    version = sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    # Serialize preparation for the same assignment (unique source-version constraint is a second guard).
    session.execute(select(Assignment).where(Assignment.id == assignment_id).with_for_update())
    report = session.scalar(select(AssignmentSummary).where(AssignmentSummary.assignment_id == assignment_id, AssignmentSummary.source_version == version))
    if report is None:
        report = AssignmentSummary(assignment_id=assignment_id, source_version=version, snapshot=snapshot, status="pending")
        session.add(report)
        session.flush()
    return report


def report_json(report):
    return {"id": str(report.id), "assignment_id": str(report.assignment_id), "source_version": report.source_version,
            "status": report.status, "statistics": report.snapshot["statistics"], "narrative": report.narrative,
            "last_error": report.last_error, "created_at": report.created_at.isoformat()}


def save_narrative(session, report, narrative):
    if report.status == "completed":
        raise ValueError("报告已完成，不可覆盖")
    if prepare_summary(session, report.assignment_id).source_version != report.source_version:
        raise ValueError("报告输入版本已改变，不能保存过时总结")
    if not isinstance(narrative, dict) or set(narrative) != {"overall", "question_highlights", "student_highlights"}:
        raise ValueError("报告需要 overall、question_highlights、student_highlights")
    students = {s["student_id"]: s for s in report.snapshot["students"]}
    questions = {i["question_id"] for i in report.snapshot["items"]}
    stat_refs = {"overall." + key for key in report.snapshot["statistics"]["overall"]}
    for q in report.snapshot["statistics"]["questions"]:
        stat_refs.update(f"questions.{q['question_id']}.{key}" for key in q)
    for s in report.snapshot["statistics"]["students"]:
        stat_refs.update(f"students.{s['student_id']}.{key}" for key in ("score", "score_rate", "cells"))
    def check(item, scope, category=None):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip():
            raise ValueError("报告条目需要非空 text")
        if category and item.get("type") not in category:
            raise ValueError("报告条目类型无效")
        grades = {g["id"] for s in scope for g in s["grades"]}
        allowed_stats = {ref for ref in stat_refs if not ref.startswith("students.") or any(ref.startswith(f"students.{s['student_id']}.") for s in scope)}
        snapshots = {s["profile_snapshot_id"] for s in scope}
        paths = {(h["id"], c["path"]) for s in scope for h in s["changes"] for c in (h.get("after") or {}).get("changes", [])}
        used = 0
        for field, allowed in (("stat_refs", allowed_stats), ("grading_result_refs", grades), ("profile_snapshot_refs", snapshots), ("question_ids", questions)):
            refs = item.get(field, [])
            if not isinstance(refs, list) or any(not isinstance(ref, str) or ref not in allowed for ref in refs):
                raise ValueError(f"{field} 包含无效引用")
            if field != "question_ids":
                used += len(refs)
        change_refs = item.get("profile_change_refs", [])
        if not isinstance(change_refs, list):
            raise ValueError("profile_change_refs 必须是数组")
        for ref in change_refs:
            if not isinstance(ref, dict) or (ref.get("audit_id"), ref.get("path")) not in paths:
                raise ValueError("学生变更引用无效")
            used += 1
        if not used:
            raise ValueError("报告条目必须引用事实依据")
    check(narrative["overall"], list(students.values()))
    for field in ("question_highlights", "student_highlights"):
        if not isinstance(narrative[field], list):
            raise ValueError("重点必须是数组，可为空")
    for item in narrative["question_highlights"]:
        check(item, list(students.values()), {"well_completed", "difficulty", "mixed_performance"})
    for item in narrative["student_highlights"]:
        if not isinstance(item, dict) or item.get("student_id") not in students:
            raise ValueError("学生不在本报告范围")
        check(item, [students[item["student_id"]]], {"progress", "unusual_performance", "mixed_performance"})
        if item["type"] == "progress" and not (item.get("profile_change_refs") or item.get("profile_snapshot_refs")):
            raise ValueError("进步判断需要前后比较依据")
    report.narrative = narrative
    report.status = "completed"
    report.last_error = None
