"""Frozen evaluator inputs and deterministic assignment reporting."""
from copy import deepcopy
from hashlib import sha256
import json
from uuid import UUID

from sqlalchemy import select

from .models import Assignment, AssignmentSummary, EvaluationReceipt, Student, StudentObservation


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


def receipt_history(history_records):
    return [{"id": h["id"], "created_at": h["created_at"],
             "before": {"description": (h.get("before") or {}).get("description"),
                        "evidence_buffer": (h.get("before") or {}).get("evidence_buffer")},
             "after": {"description": (h.get("after") or {}).get("description"),
                       "evidence_buffer": (h.get("after") or {}).get("evidence_buffer"),
                       "changes": list((h.get("after") or {}).get("changes") or [])}}
            for h in history_records]


def assert_student_highlight_coverage(students, highlights):
    highlighted = {}
    for item in highlights:
        highlighted.setdefault(item.get("student_id"), []).append(item)
    for student in students:
        include = (student.get("report_significance") or {}).get("include_in_teacher_report")
        student_id = student["student_id"]
        if include is True and student_id not in highlighted:
            raise ValueError("必须报告 Evaluator 标记为纳入报告的学生")
        if include is False and any(item.get("type") != "current_submission_anomaly" for item in highlighted.get(student_id, [])):
            raise ValueError("Evaluator 未纳入报告的学生只能报告本次作业异常")


def complete_evaluation(session, assignment_id, student_id, description, evidence_buffer=None, report_significance=None):
    from .minerva_tools import _json_value, empty_report_significance
    grades = collect_pages(session, resource="grading_results", assignment_id=assignment_id, student_id=student_id, grader_type="ai")
    if not grades:
        raise ValueError("评估完成必须有当前提交的批改结果")
    submission_id = UUID(grades[0]["submission_id"])
    history = receipt_history(collect_pages(session, resource="observation_history", assignment_id=assignment_id, student_id=student_id))
    student_name = session.get(Student, student_id).name
    observation = session.get(StudentObservation, student_id)
    buffer = evidence_buffer if evidence_buffer is not None else ([] if observation is None else observation.evidence_buffer)
    receipt = session.get(EvaluationReceipt, (assignment_id, student_id))
    if receipt is None:
        receipt = EvaluationReceipt(assignment_id=assignment_id, student_id=student_id, submission_id=submission_id)
        session.add(receipt)
    receipt.submission_id = submission_id
    receipt.snapshot = _json_value({
        "student_id": str(student_id),
        "student_name": student_name,
        "profile_snapshot_id": f"{assignment_id}:{student_id}",
        "description": deepcopy(description),
        "evidence_buffer": deepcopy(buffer),
        "changes": history,
        "grades": grades,
        "report_significance": report_significance or empty_report_significance(),
    })


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


def _unique_strings(values):
    result = []
    for value in values or []:
        text = str(value or "").strip()
        if text and text not in result:
            result.append(text)
    return result


def build_report_context(title, students, items, statistics):
    """Arrange the frozen report snapshot into one model-ready context."""
    student_rows = {row["student_id"]: row for row in statistics["students"]}
    topics, abilities, difficulties, questions = {}, {}, {}, []
    grades_by_student = {}
    for student in students:
        latest = {}
        for grade in student["grades"]:
            latest.setdefault(grade["question_id"], grade)
        grades_by_student[student["student_id"]] = latest

    stats_by_question = {row["question_id"]: row for row in statistics["questions"]}
    for item in items:
        question_id = item["question_id"]
        snapshot = item.get("question_snapshot") if isinstance(item.get("question_snapshot"), dict) else {}
        analysis = snapshot.get("analysis") if isinstance(snapshot.get("analysis"), dict) else {}
        domain = str(analysis.get("knowledge_domain") or "未分类").strip() or "未分类"
        main_concepts = _unique_strings(analysis.get("main_concepts") or snapshot.get("knowledge_points"))
        required_abilities = _unique_strings(analysis.get("required_abilities"))
        difficulty = str(analysis.get("difficulty") or "unknown")
        topic = topics.setdefault(domain, {"knowledge_domain": domain, "question_ids": [], "positions": [], "score_weight": 0.0, "main_concepts": []})
        topic["question_ids"].append(question_id)
        topic["positions"].append(item["position"])
        topic["score_weight"] += float(item["max_score"])
        topic["main_concepts"] = _unique_strings(topic["main_concepts"] + main_concepts)
        for ability in required_abilities:
            entry = abilities.setdefault(ability, {"ability": ability, "question_ids": [], "positions": []})
            entry["question_ids"].append(question_id)
            entry["positions"].append(item["position"])
        entry = difficulties.setdefault(difficulty, {"difficulty": difficulty, "question_ids": [], "positions": []})
        entry["question_ids"].append(question_id)
        entry["positions"].append(item["position"])

        student_results = []
        for student in students:
            grade = grades_by_student[student["student_id"]][question_id]
            student_results.append({
                "student_id": student["student_id"],
                "student_name": student["student_name"],
                "grading_result_id": grade["id"],
                "score": grade["score"],
                "max_score": item["max_score"],
                "answer_payload": grade.get("answer_payload"),
                "grading_basis": grade.get("feedback"),
                "rubric_result": grade.get("rubric_result"),
                "confidence": grade.get("confidence"),
            })
        questions.append({
            "question_id": question_id,
            "position": item["position"],
            "question_type": snapshot.get("question_type") or analysis.get("question_type") or "unknown",
            "stem": snapshot.get("stem") or "",
            "max_score": item["max_score"],
            "analysis": {
                "subject": analysis.get("subject"),
                "knowledge_domain": domain,
                "main_concepts": main_concepts,
                "expected_path": _unique_strings(analysis.get("expected_path")),
                "dependencies": _unique_strings(analysis.get("dependencies")),
                "difficulty": difficulty,
                "required_abilities": required_abilities,
            },
            "statistics": stats_by_question[question_id],
            "student_results": student_results,
        })

    student_context = []
    for student in students:
        row = student_rows[student["student_id"]]
        student_context.append({
            "student_id": student["student_id"],
            "student_name": student["student_name"],
            "profile_snapshot_id": student["profile_snapshot_id"],
            "score": row["score"],
            "max_score": row["max_score"],
            "score_rate": row["score_rate"],
            "description": student.get("description"),
            "evidence_buffer": student.get("evidence_buffer") or [],
            "profile_changes": student.get("changes") or [],
            "report_significance": student.get("report_significance") or {},
        })

    subjects = _unique_strings(
        (item.get("question_snapshot") or {}).get("analysis", {}).get("subject")
        for item in items
        if isinstance(item.get("question_snapshot"), dict)
        and isinstance((item.get("question_snapshot") or {}).get("analysis"), dict)
    )
    return {
        "assignment": {
            "title": title,
            "subjects": subjects,
            "question_count": len(items),
            "total_score": sum(float(item["max_score"]) for item in items),
            "knowledge_distribution": list(topics.values()),
            "ability_distribution": list(abilities.values()),
            "difficulty_distribution": list(difficulties.values()),
        },
        "statistics": statistics,
        "questions": questions,
        "students": student_context,
    }


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
    statistics = build_statistics(snapshots, items)
    snapshot = _json_value({
        "title": assignment.title,
        "students": snapshots,
        "items": items,
        "statistics": statistics,
        "report_context": build_report_context(assignment.title, snapshots, items, statistics),
    })
    version = sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    # Serialize preparation for the same assignment (unique source-version constraint is a second guard).
    session.execute(select(Assignment).where(Assignment.id == assignment_id).with_for_update())
    report = session.scalar(select(AssignmentSummary).where(AssignmentSummary.assignment_id == assignment_id, AssignmentSummary.source_version == version))
    if report is None:
        report = AssignmentSummary(assignment_id=assignment_id, source_version=version, snapshot=snapshot, status="pending")
        session.add(report)
        session.flush()
    return report


def report_json(report, include_context=False):
    payload = {"id": str(report.id), "assignment_id": str(report.assignment_id), "source_version": report.source_version,
               "status": report.status, "statistics": report.snapshot["statistics"], "narrative": report.narrative,
               "last_error": report.last_error, "created_at": report.created_at.isoformat()}
    if include_context:
        payload["report_context"] = report.snapshot["report_context"]
    return payload


def save_narrative(session, report, narrative):
    if report.status == "completed":
        raise ValueError("报告已完成，不可覆盖")
    if prepare_summary(session, report.assignment_id).source_version != report.source_version:
        raise ValueError("报告输入版本已改变，不能保存过时总结")
    required_fields = {"assignment_overview", "overall", "well_completed_questions", "problem_questions", "student_highlights"}
    if not isinstance(narrative, dict) or set(narrative) != required_fields:
        raise ValueError("报告结构不完整")
    students = {s["student_id"]: s for s in report.snapshot["students"]}
    questions = {i["question_id"] for i in report.snapshot["items"]}
    grade_questions = {g["id"]: g["question_id"] for s in students.values() for g in s["grades"]}
    stat_refs = {"overall." + key for key in report.snapshot["statistics"]["overall"]}
    for q in report.snapshot["statistics"]["questions"]:
        stat_refs.update(f"questions.{q['question_id']}.{key}" for key in q)
    for s in report.snapshot["statistics"]["students"]:
        stat_refs.update(f"students.{s['student_id']}.{key}" for key in ("score", "score_rate", "cells"))
    def check(item, scope, category=None, question_evidence=False):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip():
            raise ValueError("报告条目需要非空 text")
        if category and item.get("type") not in category:
            raise ValueError("报告条目类型无效")
        grades = {g["id"] for s in scope for g in s["grades"]}
        allowed_stats = {ref for ref in stat_refs if not ref.startswith("students.") or any(ref.startswith(f"students.{s['student_id']}.") for s in scope)}
        snapshots = {s["profile_snapshot_id"] for s in scope}
        buffer_ids = {item.get("candidate_id") for s in scope for item in (s.get("evidence_buffer") or []) if isinstance(item, dict) and item.get("candidate_id")}
        profile_paths = {(h["id"], c["path"]) for s in scope for h in s["changes"] for c in (h.get("after") or {}).get("changes", []) if str(c.get("path") or "").startswith("/description/")}
        buffer_paths = {(h["id"], c["path"]) for s in scope for h in s["changes"] for c in (h.get("after") or {}).get("changes", []) if str(c.get("path") or "").startswith("/evidence_buffer/")}
        used = 0
        for field, allowed in (("stat_refs", allowed_stats), ("grading_result_refs", grades), ("profile_snapshot_refs", snapshots), ("question_ids", questions), ("buffer_candidate_ids", buffer_ids)):
            refs = item.get(field, [])
            if not isinstance(refs, list) or any(not isinstance(ref, str) or ref not in allowed for ref in refs):
                raise ValueError(f"{field} 包含无效引用")
            if field != "question_ids" or question_evidence:
                used += len(refs)
        for field, allowed_paths, label in (("profile_change_refs", profile_paths, "学生变更引用无效"), ("buffer_change_refs", buffer_paths, "缓冲层变更引用无效")):
            change_refs = item.get(field, [])
            if not isinstance(change_refs, list):
                raise ValueError(f"{field} 必须是数组")
            for ref in change_refs:
                if not isinstance(ref, dict) or (ref.get("audit_id"), ref.get("path")) not in allowed_paths:
                    raise ValueError(label)
                used += 1
        if not used:
            raise ValueError("报告条目必须引用事实依据")
    check(narrative["assignment_overview"], list(students.values()), question_evidence=True)
    if not narrative["assignment_overview"].get("question_ids"):
        raise ValueError("作业内容介绍必须引用题目")
    check(narrative["overall"], list(students.values()))
    if not narrative["overall"].get("stat_refs"):
        raise ValueError("整体完成情况必须引用统计")
    for field in ("well_completed_questions", "problem_questions", "student_highlights"):
        if not isinstance(narrative[field], list):
            raise ValueError("重点必须是数组，可为空")
    for item in narrative["well_completed_questions"]:
        check(item, list(students.values()))
        if not item.get("question_ids") or not item.get("stat_refs"):
            raise ValueError("完成较好的题目必须引用题目和统计")
    for item in narrative["problem_questions"]:
        check(item, list(students.values()))
        if not item.get("question_ids") or not item.get("stat_refs") or not item.get("grading_result_refs"):
            raise ValueError("重点问题必须引用题目、统计和批改结果")
        if any(grade_questions[ref] not in item["question_ids"] for ref in item["grading_result_refs"]):
            raise ValueError("重点问题的批改结果必须属于所引用题目")
    for item in narrative["student_highlights"]:
        if not isinstance(item, dict) or item.get("student_id") not in students:
            raise ValueError("学生不在本报告范围")
        check(item, [students[item["student_id"]]], {"progress", "unusual_performance", "mixed_performance", "observation", "current_submission_anomaly"})
        if item["type"] == "progress" and not (item.get("profile_change_refs") or item.get("profile_snapshot_refs")):
            raise ValueError("进步判断需要前后比较依据")
        if item["type"] == "current_submission_anomaly" and not (item.get("grading_result_refs") and item.get("stat_refs")):
            raise ValueError("本次作业异常必须同时引用成绩统计和批改结果")
        if item.get("grading_result_refs") and (
            not item.get("question_ids")
            or any(grade_questions[ref] not in item["question_ids"] for ref in item["grading_result_refs"])
        ):
            raise ValueError("学生重点的批改结果必须对应所引用题目")
    assert_student_highlight_coverage(list(students.values()), narrative["student_highlights"])
    report.narrative = narrative
    report.status = "completed"
    report.last_error = None
