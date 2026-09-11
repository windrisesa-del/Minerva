from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime
from decimal import Decimal
from math import isfinite
from typing import Any
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .models import (
    AnswerAttempt,
    Assignment,
    AssignmentItem,
    AuditLog,
    EvaluationReceipt,
    GradingResult,
    Student,
    StudentObservation,
    Submission,
    Teacher,
)

DESCRIPTION_FIELDS = {
    "knowledge_profile",
    "problem_solving_and_learning_profile",
    "learning_trajectory",
}

KNOWLEDGE_ATTRIBUTES = {
    "mastery_level",
    "mastered_parts",
    "unmastered_parts",
    "mastery_boundaries",
    "common_errors",
}

PROBLEM_SOLVING_ATTRIBUTES = {
    "strong_problem_types",
    "difficult_problem_types",
    "reasoning_characteristics",
    "learning_strategies_and_habits",
}

TRAJECTORY_ATTRIBUTES = {
    "recent_progress",
    "recent_regressions",
    "emerging_problems",
    "developing_abilities",
}

BUFFER_STATUSES = {"collecting", "contradicted"}
EVIDENCE_RELATIONSHIPS = {"supports", "contradicts", "context_only"}
ERROR_TYPES = {"none", "conceptual_error", "procedural_error", "careless_error", "blank", "unreadable"}
KNOWLEDGE_RESULT_VALUES = {"correct", "incorrect", "partial", "not_assessed"}
REPORT_LEVELS = {"none", "low", "medium", "high"}
REPORT_SIGNIFICANCE_TYPES = {"progress", "unusual_performance", "mixed_performance", "observation"}


def _snapshot_knowledge_ids(snapshot: dict[str, Any] | None) -> set[str]:
    from .assessment_adapter import knowledge_ids_from_analysis

    ids: set[str] = set()
    if not isinstance(snapshot, dict):
        return ids
    points = snapshot.get("knowledge_points")
    if isinstance(points, list):
        ids.update(str(item).strip() for item in points if str(item).strip())
    analysis = snapshot.get("analysis")
    if isinstance(analysis, dict):
        ids.update(knowledge_ids_from_analysis(analysis))
    return ids


def _clean_knowledge_results(raw: Any, snapshot: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise ValueError("knowledge_results 必须是数组")
    allowed = _snapshot_knowledge_ids(snapshot)
    cleaned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("knowledge_results 中的项必须是对象")
        knowledge_id = _clean_text(item.get("knowledge_id"), "knowledge_id", required=True)
        if allowed and knowledge_id not in allowed:
            raise ValueError(f"knowledge_id 不在当前题目知识点中：{knowledge_id}")
        result = _clean_text(item.get("result"), "result", required=True)
        if result not in KNOWLEDGE_RESULT_VALUES:
            raise ValueError("knowledge_results.result 只能是 correct、incorrect、partial 或 not_assessed")
        if knowledge_id in seen:
            raise ValueError(f"knowledge_results 重复 knowledge_id：{knowledge_id}")
        seen.add(knowledge_id)
        entry = {"knowledge_id": knowledge_id, "result": result}
        note = _clean_text(item.get("note"), "note")
        if note:
            entry["note"] = note
        cleaned.append(entry)
    return cleaned


def _clean_rubric_items(raw: Any, max_score: float) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise ValueError("rubric_items 必须是数组")
    cleaned: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("rubric_items 中的项必须是对象")
        requirement = _clean_text(item.get("requirement"), "requirement", required=True)
        score = _required_finite_float(item.get("score"), "rubric_items.score")
        item_max = _optional_finite_float(item.get("max_score"), "rubric_items.max_score")
        if item_max is None:
            item_max = max_score
        if score < 0 or score > item_max:
            raise ValueError("rubric_items.score 必须在 0 到该项满分之间")
        if item_max > max_score:
            raise ValueError("rubric_items.max_score 不能超过题目满分")
        hit = item.get("hit")
        if hit is not None and not isinstance(hit, bool):
            raise ValueError("rubric_items.hit 必须是布尔值")
        entry: dict[str, Any] = {"requirement": requirement, "score": score, "max_score": item_max}
        if isinstance(hit, bool):
            entry["hit"] = hit
        cleaned.append(entry)
    return cleaned


def _clean_rubric_result(
    raw: dict[str, Any],
    *,
    max_score: float,
    snapshot: dict[str, Any] | None,
    overall_feedback: Any,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "is_correct": raw.get("is_correct"),
        "max_score": max_score,
        "overall_feedback": str(overall_feedback).strip() or None if overall_feedback not in (None, "") else None,
    }
    error_type = raw.get("error_type")
    if error_type is not None and str(error_type).strip():
        cleaned_type = str(error_type).strip()
        if cleaned_type not in ERROR_TYPES:
            raise ValueError("error_type 只能是 none、conceptual_error、procedural_error、careless_error、blank 或 unreadable")
        result["error_type"] = cleaned_type
    if raw.get("knowledge_results") is not None:
        result["knowledge_results"] = _clean_knowledge_results(raw.get("knowledge_results"), snapshot)
    if raw.get("rubric_items") is not None:
        result["rubric_items"] = _clean_rubric_items(raw.get("rubric_items"), max_score)
    return result


def empty_report_significance() -> dict[str, Any]:
    return {
        "include_in_teacher_report": False,
        "level": "none",
        "type": None,
        "message": "",
        "question_ids": [],
        "buffer_candidate_ids": [],
    }


def _clean_report_significance(raw: Any, *, required: bool) -> dict[str, Any] | None:
    if raw is None:
        return empty_report_significance() if required else None
    if not isinstance(raw, dict):
        raise ValueError("report_significance 必须是对象")
    include = raw.get("include_in_teacher_report")
    if not isinstance(include, bool):
        raise ValueError("include_in_teacher_report 必须是布尔值")
    level = _clean_text(raw.get("level") or ("medium" if include else "none"), "level")
    if level not in REPORT_LEVELS:
        raise ValueError("report_significance.level 只能是 none、low、medium 或 high")
    if include and level == "none":
        raise ValueError("纳入报告时 level 不能是 none")
    message = _clean_text(raw.get("message"), "message", required=include)
    sig_type = _clean_text(raw.get("type"), "type")
    if include:
        if sig_type not in REPORT_SIGNIFICANCE_TYPES:
            raise ValueError("纳入报告时 type 必须是 progress、unusual_performance、mixed_performance 或 observation")
    elif sig_type and sig_type not in REPORT_SIGNIFICANCE_TYPES:
        raise ValueError("report_significance.type 无效")
    return {
        "include_in_teacher_report": include,
        "level": level,
        "type": sig_type or None,
        "message": message,
        "question_ids": _clean_string_list(raw.get("question_ids"), "question_ids"),
        "buffer_candidate_ids": _clean_string_list(raw.get("buffer_candidate_ids"), "buffer_candidate_ids"),
    }


READ_RESOURCES = {
    "assignments",
    "submissions",
    "students",
    "classes",
    "enrollments",
    "questions",
    "assignment_items",
    "answer_attempts",
    "grading_results",
    "graded_students",
    "audit_logs",
    "observation_history",
    "student_description",
    "evidence_buffer",
}

WRITE_KINDS = {"grading", "student_description", "evidence_buffer", "student_observation", "processing"}
ACTIVE_SUBMISSION_STATUSES = ("submitted", "grading", "graded")
PROCESSING_STATUSES = {"submitted", "grading", "graded"}


def _empty_description() -> dict[str, Any]:
    return {
        "knowledge_profile": {"knowledge_points": {}},
        "problem_solving_and_learning_profile": {
            "strong_problem_types": [],
            "difficult_problem_types": [],
            "reasoning_characteristics": [],
            "learning_strategies_and_habits": [],
            "evidence_refs": [],
        },
        "learning_trajectory": {
            "recent_progress": [],
            "recent_regressions": [],
            "emerging_problems": [],
            "developing_abilities": [],
            "evidence_refs": [],
        },
    }


def _canonical_description(value: Any) -> dict[str, Any]:
    current = value if isinstance(value, dict) else {}
    canonical = _empty_description()
    for field in DESCRIPTION_FIELDS:
        if isinstance(current.get(field), dict):
            canonical[field] = current[field]
    return canonical


def _clean_text(value: Any, field: str, *, required: bool = False) -> str:
    text_value = str(value or "").strip()
    if required and not text_value:
        raise ValueError(f"{field} 不能为空")
    return text_value


def _clean_string_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field} 必须是数组")
    cleaned: list[str] = []
    for item in value:
        text_value = str(item or "").strip()
        if text_value and text_value not in cleaned:
            cleaned.append(text_value)
    return cleaned


_EVIDENCE_REF_KEYS = ("assignment_id", "submission_id", "question_id", "answer_attempt_id", "grading_result_id")


def _evidence_ref_from_raw(raw: Any, field: str) -> dict[str, Any]:
    if isinstance(raw, str) and raw.strip():
        raw = {"grading_result_id": raw.strip()}
    if not isinstance(raw, dict):
        raise ValueError(f"{field} 中的证据引用必须是对象或 grading_result_id 字符串")
    source = raw.get("source") if isinstance(raw.get("source"), dict) else {}
    ref: dict[str, Any] = {}
    for key in _EVIDENCE_REF_KEYS:
        value = raw.get(key)
        if value is None or str(value).strip() == "":
            value = source.get(key)
        if value is not None and str(value).strip():
            ref[key] = str(value).strip()
    observed_at = _clean_text(raw.get("observed_at") or source.get("observed_at"), f"{field}.observed_at")
    if observed_at:
        ref["observed_at"] = observed_at
    if not ref:
        raise ValueError(f"{field} 需要 grading_result_id，主机可根据它补全题目和提交信息")
    return ref


def _clean_evidence_refs(value: Any, field: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field} 必须是数组")
    cleaned: list[dict[str, Any]] = []
    for raw in value:
        ref = _evidence_ref_from_raw(raw, field)
        if ref not in cleaned:
            cleaned.append(ref)
    return cleaned


def _clean_profile_fields(fields: Any) -> dict[str, Any]:
    if not isinstance(fields, dict) or not fields:
        raise ValueError("profile_fields 不能为空")
    unknown = [key for key in fields if key not in DESCRIPTION_FIELDS]
    if unknown:
        raise ValueError(f"不支持的描述字段：{', '.join(unknown)}")
    cleaned: dict[str, Any] = {}
    if "knowledge_profile" in fields:
        raw_profile = fields["knowledge_profile"]
        if not isinstance(raw_profile, dict) or not isinstance(raw_profile.get("knowledge_points", {}), dict):
            raise ValueError("knowledge_profile.knowledge_points 必须是对象")
        knowledge_points: dict[str, Any] = {}
        for raw_id, raw_point in raw_profile.get("knowledge_points", {}).items():
            knowledge_id = _clean_text(raw_id, "knowledge_id", required=True)
            if not isinstance(raw_point, dict):
                raise ValueError(f"知识点 {knowledge_id} 必须是对象")
            mastery_level = raw_point.get("mastery_level")
            if mastery_level is not None:
                if isinstance(mastery_level, bool) or not isinstance(mastery_level, int) or not 1 <= mastery_level <= 5:
                    raise ValueError(f"知识点 {knowledge_id} 的 mastery_level 必须是 1 到 5 的整数或 null")
            cleaned_point = {
                "knowledge_name": _clean_text(raw_point.get("knowledge_name") or knowledge_id, "knowledge_name", required=True),
                "mastery_level": mastery_level,
                "mastery_reason": _clean_text(raw_point.get("mastery_reason"), "mastery_reason"),
                "mastered_parts": _clean_string_list(raw_point.get("mastered_parts"), "mastered_parts"),
                "unmastered_parts": _clean_string_list(raw_point.get("unmastered_parts"), "unmastered_parts"),
                "mastery_boundaries": _clean_string_list(raw_point.get("mastery_boundaries"), "mastery_boundaries"),
                "common_errors": _clean_string_list(raw_point.get("common_errors"), "common_errors"),
                "evidence_refs": _clean_evidence_refs(raw_point.get("evidence_refs"), "knowledge_profile.evidence_refs"),
            }
            subject = _clean_text(raw_point.get("subject"), "subject")
            knowledge_domain = _clean_text(raw_point.get("knowledge_domain"), "knowledge_domain")
            if subject:
                cleaned_point["subject"] = subject
            if knowledge_domain:
                cleaned_point["knowledge_domain"] = knowledge_domain
            knowledge_points[knowledge_id] = cleaned_point
        cleaned["knowledge_profile"] = {"knowledge_points": knowledge_points}
    if "problem_solving_and_learning_profile" in fields:
        raw_profile = fields["problem_solving_and_learning_profile"]
        if not isinstance(raw_profile, dict):
            raise ValueError("problem_solving_and_learning_profile 必须是对象")
        unknown_attributes = [key for key in raw_profile if key not in PROBLEM_SOLVING_ATTRIBUTES | {"evidence_refs"}]
        if unknown_attributes:
            raise ValueError(f"问题处理与学习画像不支持字段：{', '.join(unknown_attributes)}")
        cleaned["problem_solving_and_learning_profile"] = {
            key: _clean_string_list(raw_profile.get(key), key)
            for key in PROBLEM_SOLVING_ATTRIBUTES
        } | {"evidence_refs": _clean_evidence_refs(raw_profile.get("evidence_refs"), "problem_solving_and_learning_profile.evidence_refs")}
    if "learning_trajectory" in fields:
        raw_profile = fields["learning_trajectory"]
        if not isinstance(raw_profile, dict):
            raise ValueError("learning_trajectory 必须是对象")
        unknown_attributes = [key for key in raw_profile if key not in TRAJECTORY_ATTRIBUTES | {"evidence_refs"}]
        if unknown_attributes:
            raise ValueError(f"学习变化不支持字段：{', '.join(unknown_attributes)}")
        cleaned["learning_trajectory"] = {
            key: _clean_string_list(raw_profile.get(key), key)
            for key in TRAJECTORY_ATTRIBUTES
        } | {"evidence_refs": _clean_evidence_refs(raw_profile.get("evidence_refs"), "learning_trajectory.evidence_refs")}
    return cleaned


def _validate_buffer_target(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("Evidence Buffer 的 target 必须是对象")
    section = _clean_text(raw.get("profile_section"), "profile_section", required=True)
    attribute = _clean_text(raw.get("attribute"), "attribute", required=True)
    knowledge_id = _clean_text(raw.get("knowledge_id"), "knowledge_id")
    if section == "knowledge_profile":
        if attribute not in KNOWLEDGE_ATTRIBUTES:
            raise ValueError(f"knowledge_profile 不支持属性 {attribute}")
        if not knowledge_id:
            raise ValueError("knowledge_profile 候选判断必须提供 knowledge_id")
    elif section == "problem_solving_and_learning_profile":
        if attribute not in PROBLEM_SOLVING_ATTRIBUTES:
            raise ValueError(f"problem_solving_and_learning_profile 不支持属性 {attribute}")
        if knowledge_id:
            raise ValueError("problem_solving_and_learning_profile 不应提供 knowledge_id")
    elif section == "learning_trajectory":
        if attribute not in TRAJECTORY_ATTRIBUTES:
            raise ValueError(f"learning_trajectory 不支持属性 {attribute}")
        if knowledge_id:
            raise ValueError("learning_trajectory 不应提供 knowledge_id")
    else:
        raise ValueError("profile_section 只能是三个规定的学生描述部分")
    return {
        "profile_section": section,
        **({"knowledge_id": knowledge_id} if knowledge_id else {}),
        "attribute": attribute,
    }


def _clean_evidence_buffer(items: Any) -> list[dict[str, Any]]:
    if not isinstance(items, list):
        raise ValueError("buffer_items 必须是数组")
    cleaned: list[dict[str, Any]] = []
    candidate_ids: set[str] = set()
    for raw in items:
        if not isinstance(raw, dict):
            raise ValueError("Evidence Buffer 中的候选判断必须是对象")
        candidate_id = _clean_text(raw.get("candidate_id"), "candidate_id", required=True)
        if candidate_id in candidate_ids:
            raise ValueError(f"candidate_id 重复：{candidate_id}")
        candidate_ids.add(candidate_id)
        status = _clean_text(raw.get("status") or "collecting", "status")
        if status not in BUFFER_STATUSES:
            raise ValueError("Evidence Buffer status 只能是 collecting 或 contradicted")
        raw_evidence = raw.get("evidence")
        if not isinstance(raw_evidence, list) or not raw_evidence:
            raise ValueError(f"候选判断 {candidate_id} 至少需要一条 evidence")
        evidence: list[dict[str, Any]] = []
        evidence_ids: set[str] = set()
        for raw_item in raw_evidence:
            if not isinstance(raw_item, dict):
                raise ValueError("evidence 必须是对象")
            evidence_id = _clean_text(raw_item.get("evidence_id"), "evidence_id", required=True)
            if evidence_id in evidence_ids:
                raise ValueError(f"候选判断 {candidate_id} 中 evidence_id 重复：{evidence_id}")
            evidence_ids.add(evidence_id)
            relationship = _clean_text(raw_item.get("relationship"), "relationship", required=True)
            if relationship not in EVIDENCE_RELATIONSHIPS:
                raise ValueError("relationship 只能是 supports、contradicts 或 context_only")
            relevance = _optional_finite_float(raw_item.get("relevance"), "relevance")
            reliability = _optional_finite_float(raw_item.get("reliability"), "reliability")
            for field_name, number in (("relevance", relevance), ("reliability", reliability)):
                if number is not None and not 0 <= number <= 1:
                    raise ValueError(f"{field_name} 必须在 0 到 1 之间")
            evidence.append({
                "evidence_id": evidence_id,
                "observation": _clean_text(raw_item.get("observation"), "observation", required=True),
                "relationship": relationship,
                "evidence_type": _clean_text(raw_item.get("evidence_type") or "answer_performance", "evidence_type"),
                "relevance": relevance,
                "reliability": reliability,
                "source": _evidence_ref_from_raw(raw_item, f"evidence.{evidence_id}"),
            })
        assessment = raw.get("assessment")
        if not isinstance(assessment, dict):
            raise ValueError(f"候选判断 {candidate_id} 必须提供 assessment")
        confidence = _optional_finite_float(assessment.get("confidence"), "assessment.confidence")
        if confidence is None or not 0 <= confidence <= 1:
            raise ValueError("assessment.confidence 必须在 0 到 1 之间")
        cleaned.append({
            "candidate_id": candidate_id,
            "target": _validate_buffer_target(raw.get("target")),
            "claim": _clean_text(raw.get("claim"), "claim", required=True),
            "status": status,
            "evidence": evidence,
            "summary": {
                "supporting_count": sum(item["relationship"] == "supports" for item in evidence),
                "contradicting_count": sum(item["relationship"] == "contradicts" for item in evidence),
                "context_count": sum(item["relationship"] == "context_only" for item in evidence),
            },
            "assessment": {
                "confidence": confidence,
                "reason": _clean_text(assessment.get("reason"), "assessment.reason", required=True),
                "missing_evidence": _clean_string_list(assessment.get("missing_evidence"), "assessment.missing_evidence"),
            },
            "recommended_action": "KEEP_BUFFERED",
            "created_at": _clean_text(raw.get("created_at"), "created_at") or datetime.now().astimezone().isoformat(),
            "updated_at": datetime.now().astimezone().isoformat(),
        })
    return cleaned


def _json_value(value: Any) -> Any:
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_value(item) for item in value]
    return value


def _rows(session: Session, sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    result = session.execute(text(sql), params or {})
    return [_json_value(dict(row)) for row in result.mappings()]


def read_minerva(
    session: Session,
    *,
    resource: str,
    id: UUID | None = None,
    assignment_id: UUID | None = None,
    student_id: UUID | None = None,
    submission_id: UUID | None = None,
    question_id: UUID | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
    include_private: bool = False,
    include_voided: bool = False,
    grader_type: str | None = None,
) -> dict[str, Any]:
    if resource not in READ_RESOURCES:
        raise ValueError(f"不支持读取 {resource}")
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    if resource == "assignments":
        clauses = ["TRUE"]
        params: dict[str, Any] = {"limit": limit, "status": (status or "").strip()}
        if id is not None:
            clauses.append("id = :id")
            params["id"] = id
        if params["status"]:
            clauses.append("status = :status")
        sql = f"""
            SELECT id, class_id, title, status, published_at, due_at, created_by, created_at, updated_at
            FROM assignments
            WHERE {" AND ".join(clauses)}
            ORDER BY created_at DESC
            LIMIT :limit
        """
        return {"resource": resource, "records": _rows(session, sql, params)}

    if resource == "submissions":
        if assignment_id is None:
            raise ValueError("读取 submissions 需要 assignment_id")
        student_clause = ""
        params = {"assignment_id": assignment_id, "fetch_limit": limit + 1, "offset": offset}
        if student_id is not None:
            student_clause = "AND submission.student_id = :student_id"
            params["student_id"] = student_id
        sql = f"""
            WITH latest_submission AS (
              SELECT DISTINCT ON (candidate.student_id) candidate.*
              FROM submissions candidate
              WHERE candidate.assignment_id = :assignment_id
                AND candidate.status IN ('submitted', 'grading', 'graded')
              ORDER BY candidate.student_id, candidate.attempt_number DESC, candidate.id DESC
            )
            SELECT
              submission.id,
              submission.assignment_id,
              submission.student_id,
              student.name AS student_name,
              student.student_number,
              submission.status,
              submission.attempt_number,
              submission.submitted_at,
              EXISTS (
                SELECT 1
                  FROM answer_attempts answer
                  JOIN grading_results grading ON grading.answer_attempt_id = answer.id
                 WHERE answer.submission_id = submission.id
                   AND grading.grader_type = 'ai'
                   AND grading.voided_at IS NULL
              ) AS has_ai_grading
            FROM latest_submission submission
            JOIN students student ON student.id = submission.student_id
            WHERE submission.assignment_id = :assignment_id
              {student_clause}
            ORDER BY student.name, submission.id
            LIMIT :fetch_limit OFFSET :offset
        """
        rows = _rows(session, sql, params)
        has_more = len(rows) > limit
        records = rows[:limit]
        return {
            "resource": resource,
            "records": records,
            "has_more": has_more,
            "next_offset": offset + len(records) if has_more else None,
        }

    if resource == "graded_students":
        if assignment_id is None:
            raise ValueError("读取 graded_students 需要 assignment_id")
        params = {"assignment_id": assignment_id, "fetch_limit": limit + 1, "offset": offset}
        student_clause = ""
        if student_id is not None:
            student_clause = "WHERE submission.student_id = :student_id"
            params["student_id"] = student_id
        sql = f"""
            WITH latest_submission AS (
              SELECT DISTINCT ON (candidate.student_id) candidate.*
              FROM submissions candidate
              WHERE candidate.assignment_id = :assignment_id
                AND candidate.status IN ('submitted', 'grading', 'graded')
              ORDER BY candidate.student_id, candidate.attempt_number DESC, candidate.id DESC
            )
            SELECT
              student.id AS student_id,
              student.name AS student_name,
              student.student_number,
              submission.id AS submission_id,
              COUNT(grading.id) AS grading_result_count
            FROM latest_submission submission
            JOIN students student ON student.id = submission.student_id
            JOIN answer_attempts answer ON answer.submission_id = submission.id
            JOIN grading_results grading
              ON grading.answer_attempt_id = answer.id
             AND grading.grader_type = 'ai'
             AND grading.voided_at IS NULL
            {student_clause}
            GROUP BY student.id, student.name, student.student_number, submission.id
            ORDER BY student.name, student.id
            LIMIT :fetch_limit OFFSET :offset
        """
        rows = _rows(session, sql, params)
        has_more = len(rows) > limit
        records = rows[:limit]
        return {
            "resource": resource,
            "records": records,
            "has_more": has_more,
            "next_offset": offset + len(records) if has_more else None,
        }

    if resource == "students":
        private = ""
        if include_private:
            private = ", profile.guardian_name, profile.guardian_phone, profile.email, profile.notes"
        params = {"limit": limit}
        id_clause = ""
        if id is not None:
            id_clause = "AND student.id = :id"
            params["id"] = id
        sql = f"""
            SELECT
              student.id,
              student.name,
              student.student_number,
              student.status,
              COALESCE(classroom.name, '未分班') AS class_name,
              COALESCE(enrollment.group_name, '') AS group_name
              {private}
            FROM students student
            LEFT JOIN enrollments enrollment
              ON enrollment.student_id = student.id AND enrollment.left_at IS NULL
            LEFT JOIN classes classroom ON classroom.id = enrollment.class_id
            LEFT JOIN student_private_profiles profile ON profile.student_id = student.id
            WHERE student.status = 'active'
              {id_clause}
            ORDER BY student.name
            LIMIT :limit
        """
        return {"resource": resource, "records": _rows(session, sql, params)}

    if resource == "questions":
        if assignment_id is None:
            raise ValueError("读取 questions 需要 assignment_id")
        question_clause = ""
        params = {"assignment_id": assignment_id}
        if question_id is not None:
            question_clause = "AND question.id = :question_id"
            params["question_id"] = question_id
        sql = f"""
            SELECT
              question.id,
              item.position,
              item.max_score,
              question.question_type,
              question.stem,
              question.standard_answer,
              item.question_snapshot
            FROM assignment_items item
            JOIN questions question ON question.id = item.question_id
            WHERE item.assignment_id = :assignment_id
              {question_clause}
            ORDER BY item.position
        """
        rows = _rows(session, sql, params)
        return {"resource": resource, "records": rows}

    if resource == "assignment_items":
        if assignment_id is None:
            raise ValueError("读取 assignment_items 需要 assignment_id")
        question_clause = ""
        params = {"assignment_id": assignment_id}
        if question_id is not None:
            question_clause = "AND question_id = :question_id"
            params["question_id"] = question_id
        sql = f"""
            SELECT id, assignment_id, question_id, position, max_score, question_snapshot
            FROM assignment_items
            WHERE assignment_id = :assignment_id
              {question_clause}
            ORDER BY position
        """
        return {"resource": resource, "records": _rows(session, sql, params)}

    if resource == "answer_attempts":
        if assignment_id is None or student_id is None:
            raise ValueError("读取 answer_attempts 需要 assignment_id 和 student_id")
        submission_clause = ""
        question_clause = ""
        params = {"assignment_id": assignment_id, "student_id": student_id, "limit": limit}
        if submission_id is not None:
            submission_clause = "AND submission.id = :submission_id"
            params["submission_id"] = submission_id
        if question_id is not None:
            question_clause = "AND answer.question_id = :question_id"
            params["question_id"] = question_id
        sql = f"""
            WITH latest_answer AS (
              SELECT DISTINCT ON (answer.question_id) answer.*
              FROM answer_attempts answer
              JOIN submissions submission ON submission.id = answer.submission_id
              WHERE submission.assignment_id = :assignment_id
                AND submission.student_id = :student_id
                AND submission.status IN ('submitted', 'grading', 'graded')
                {submission_clause}
                {question_clause}
              ORDER BY answer.question_id, answer.attempt_number DESC, answer.id DESC
            )
            SELECT
              answer.id,
              answer.submission_id,
              answer.question_id,
              answer.student_id,
              answer.attempt_number,
              answer.answer_payload,
              answer.is_correct,
              answer.objective_score,
              answer.answered_at,
              answer.source
            FROM latest_answer answer
            ORDER BY answer.question_id
            LIMIT :limit
        """
        rows = _rows(session, sql, params)
        return {"resource": resource, "records": rows}

    if resource == "grading_results":
        if assignment_id is None:
            raise ValueError("读取 grading_results 需要 assignment_id")
        student_clause = ""
        submission_clause = ""
        question_clause = ""
        grader_clause = ""
        params = {"assignment_id": assignment_id, "fetch_limit": limit + 1, "offset": offset}
        if student_id is not None:
            student_clause = "AND answer.student_id = :student_id"
            params["student_id"] = student_id
        if submission_id is not None:
            submission_clause = "AND submission.id = :submission_id"
            params["submission_id"] = submission_id
        if question_id is not None:
            question_clause = "AND answer.question_id = :question_id"
            params["question_id"] = question_id
        if grader_type:
            if grader_type not in {"rule", "ai", "teacher"}:
                raise ValueError("grader_type 无效")
            grader_clause = "AND grading.grader_type = :grader_type"
            params["grader_type"] = grader_type
        sql = f"""
            WITH latest_submission AS (
              SELECT DISTINCT ON (candidate.student_id) candidate.id
              FROM submissions candidate
              WHERE candidate.assignment_id = :assignment_id
                AND candidate.status IN ('submitted', 'grading', 'graded')
              ORDER BY candidate.student_id, candidate.attempt_number DESC, candidate.id DESC
            )
            SELECT
              grading.id,
              grading.answer_attempt_id,
              grading.grader_type,
              grading.score,
              grading.feedback,
              grading.rubric_result,
              grading.confidence,
              grading.model_name,
              grading.created_at,
              grading.voided_at,
              grading.void_note,
              answer.question_id,
              answer.student_id,
              answer.answer_payload,
              submission.id AS submission_id,
              item.position AS question_position,
              item.max_score,
              question.question_type,
              question.stem AS question_stem,
              item.question_snapshot -> 'analysis' AS question_analysis,
              item.question_snapshot -> 'knowledge_points' AS knowledge_points
            FROM grading_results grading
            JOIN answer_attempts answer ON answer.id = grading.answer_attempt_id
            JOIN submissions submission ON submission.id = answer.submission_id
            JOIN latest_submission latest ON latest.id = submission.id
            JOIN assignment_items item
              ON item.assignment_id = submission.assignment_id
             AND item.question_id = answer.question_id
            JOIN questions question ON question.id = answer.question_id
            WHERE submission.assignment_id = :assignment_id
              {"AND grading.voided_at IS NULL" if not include_voided else ""}
              {grader_clause}
              {student_clause}
              {submission_clause}
              {question_clause}
            ORDER BY answer.student_id, item.position, grading.created_at DESC
            LIMIT :fetch_limit OFFSET :offset
        """
        rows = _rows(session, sql, params)
        has_more = len(rows) > limit
        records = rows[:limit]
        return {
            "resource": resource,
            "records": records,
            "has_more": has_more,
            "next_offset": offset + len(records) if has_more else None,
        }

    if resource == "student_description":
        if student_id is None:
            raise ValueError("读取 student_description 需要 student_id")
        row = session.get(StudentObservation, student_id)
        record = {
            "student_id": str(student_id),
            "description": _canonical_description(None if row is None else row.description),
            "teacher_fields": [] if row is None else [field for field in row.teacher_fields if field in DESCRIPTION_FIELDS],
            "last_assignment_id": None if row is None or row.last_assignment_id is None else str(row.last_assignment_id),
            "updated_at": None if row is None else row.updated_at.isoformat(),
        }
        return {"resource": resource, "records": [_json_value(record)]}

    if resource == "evidence_buffer":
        if student_id is None:
            raise ValueError("读取 evidence_buffer 需要 student_id")
        row = session.get(StudentObservation, student_id)
        record = {
            "student_id": str(student_id),
            "items": [] if row is None else row.evidence_buffer,
            "updated_at": None if row is None else row.updated_at.isoformat(),
        }
        return {"resource": resource, "records": [_json_value(record)]}

    if resource == "classes":
        sql = """
            SELECT id, teacher_id, name, academic_year, semester, status
            FROM classes
            WHERE status = 'active'
            ORDER BY name
            LIMIT :limit
        """
        return {"resource": resource, "records": _rows(session, sql, {"limit": limit})}

    if resource == "enrollments":
        sql = """
            SELECT id, student_id, class_id, group_name, joined_at, left_at
            FROM enrollments
            WHERE left_at IS NULL
            ORDER BY joined_at DESC
            LIMIT :limit
        """
        return {"resource": resource, "records": _rows(session, sql, {"limit": limit})}

    if resource == "observation_history":
        if student_id is None:
            raise ValueError("读取 observation_history 需要 student_id")
        query = select(AuditLog).where(
            AuditLog.entity_type == "student",
            AuditLog.entity_id == student_id,
            AuditLog.action == "save_student_observation",
        )
        if assignment_id is not None:
            query = query.where(AuditLog.after_data["assignment_id"].astext == str(assignment_id))
        rows = list(session.scalars(query.order_by(AuditLog.created_at.desc(), AuditLog.id.desc()).offset(offset).limit(limit + 1)))
        records = [{"id": str(item.id), "created_at": item.created_at.isoformat(),
                    "before": item.before_data, "after": item.after_data} for item in rows[:limit]]
        return {"resource": resource, "records": _json_value(records), "has_more": len(rows) > limit,
                "next_offset": offset + len(records) if len(rows) > limit else None}

    if resource == "audit_logs":
        sql = """
            SELECT id, actor_type, action, entity_type, entity_id, created_at
            FROM audit_logs
            ORDER BY created_at DESC
            LIMIT :limit
        """
        return {"resource": resource, "records": _rows(session, sql, {"limit": limit})}

    raise ValueError(f"不支持读取 {resource}")


def write_minerva(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    kind = str(payload.get("kind") or "")
    if kind not in WRITE_KINDS:
        raise ValueError("kind 必须是 grading、student_description、evidence_buffer、student_observation 或 processing")
    if kind == "student_observation":
        return _save_student_observation(session, payload)
    if kind == "student_description":
        return _save_student_description(session, payload)
    if kind == "evidence_buffer":
        return _save_evidence_buffer(session, payload)
    if kind == "processing":
        return _save_processing(session, payload)
    if payload.get("finalize") is True:
        return _finalize_grading(session, payload)
    return _save_grading(session, payload)


def _latest_submission(session: Session, assignment_id: UUID, student_id: UUID) -> Submission | None:
    return session.scalar(
        select(Submission)
        .where(
            Submission.assignment_id == assignment_id,
            Submission.student_id == student_id,
            Submission.status.in_(ACTIVE_SUBMISSION_STATUSES),
        )
        .order_by(Submission.attempt_number.desc(), Submission.id.desc())
    )


def _submission_grading_complete(session: Session, assignment_id: UUID, submission: Submission) -> bool:
    items = list(session.scalars(select(AssignmentItem).where(AssignmentItem.assignment_id == assignment_id)))
    if not items:
        return False
    for item in items:
        answer = session.scalar(
            select(AnswerAttempt)
            .where(
                AnswerAttempt.submission_id == submission.id,
                AnswerAttempt.question_id == item.question_id,
            )
            .order_by(AnswerAttempt.attempt_number.desc())
        )
        if answer is None:
            return False
        grading = session.scalar(
            select(GradingResult).where(
                GradingResult.answer_attempt_id == answer.id,
                GradingResult.grader_type == "ai",
                GradingResult.voided_at.is_(None),
            )
        )
        if grading is None or grading.score is None:
            return False
    return True


def _refresh_assignment_processing_status(session: Session, assignment: Assignment) -> None:
    if assignment.status in {"graded", "archived"}:
        return
    candidates = list(
        session.scalars(
            select(Submission)
            .where(
                Submission.assignment_id == assignment.id,
                Submission.status.in_(ACTIVE_SUBMISSION_STATUSES),
            )
            .order_by(Submission.student_id, Submission.attempt_number.desc(), Submission.id.desc())
        )
    )
    latest: dict[UUID, Submission] = {}
    for submission in candidates:
        latest.setdefault(submission.student_id, submission)
    statuses = {row.status for row in latest.values()}
    if "grading" in statuses or "graded" in statuses:
        assignment.status = "grading"
        return
    assignment.status = "ungraded"


def _save_processing(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    assignment_id = _require_uuid(payload.get("assignment_id"), "assignment_id")
    student_id = _require_uuid(payload.get("student_id"), "student_id")
    status = str(payload.get("status") or "").strip()
    if status not in PROCESSING_STATUSES:
        raise ValueError("processing status 只能是 submitted、grading 或 graded")
    assignment = session.get(Assignment, assignment_id)
    if assignment is None:
        raise ValueError("作业不存在")
    if assignment.status == "archived":
        raise ValueError("当前作业不能更新批改进度")
    submission = _latest_submission(session, assignment_id, student_id)
    if submission is None:
        raise ValueError("该生没有已提交的答卷")
    previous = submission.status
    previous_assignment = assignment.status
    submission.status = status
    _refresh_assignment_processing_status(session, assignment)
    session.add(
        AuditLog(
            actor_type="system",
            action="set_student_processing",
            entity_type="submission",
            entity_id=submission.id,
            before_data={"status": previous, "assignment_status": previous_assignment},
            after_data={"status": status, "assignment_status": assignment.status, "student_id": str(student_id)},
        )
    )
    session.commit()
    return {
        "kind": "processing",
        "assignment_id": str(assignment_id),
        "student_id": str(student_id),
        "status": status,
        "assignment_status": assignment.status,
    }


def assignment_processing_state(session: Session, assignment_id: UUID) -> dict[str, Any]:
    assignment = session.get(Assignment, assignment_id)
    if assignment is None:
        raise ValueError("作业不存在")
    candidates = list(
        session.scalars(
            select(Submission)
            .where(
                Submission.assignment_id == assignment_id,
                Submission.status.in_(ACTIVE_SUBMISSION_STATUSES),
            )
            .order_by(Submission.student_id, Submission.attempt_number.desc(), Submission.id.desc())
        )
    )
    latest: dict[UUID, Submission] = {}
    for submission in candidates:
        latest.setdefault(submission.student_id, submission)
    students = []
    for submission in latest.values():
        student = session.get(Student, submission.student_id)
        receipt = session.get(EvaluationReceipt, (assignment_id, submission.student_id))
        students.append({
            "student_id": str(submission.student_id),
            "student_name": None if student is None else student.name,
            "submission_id": str(submission.id),
            "status": submission.status,
            "grading_complete": _submission_grading_complete(session, assignment_id, submission),
            "evaluation_complete": receipt is not None and str(receipt.submission_id) == str(submission.id),
        })
    students.sort(key=lambda item: item["student_name"] or item["student_id"])
    return {
        "assignment_id": str(assignment_id),
        "assignment_status": assignment.status,
        "students": _json_value(students),
    }


def _save_grading(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    assignment_id = _require_uuid(payload.get("assignment_id"), "assignment_id")
    student_id = _require_uuid(payload.get("student_id"), "student_id")
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("items 不能为空")

    assignment = session.get(Assignment, assignment_id)
    if assignment is None:
        raise ValueError("作业不存在")
    submission = session.scalar(
        select(Submission)
        .where(
            Submission.assignment_id == assignment_id,
            Submission.student_id == student_id,
            Submission.status.in_(ACTIVE_SUBMISSION_STATUSES),
        )
        .order_by(Submission.attempt_number.desc(), Submission.id.desc())
    )
    if submission is None or submission.status not in set(ACTIVE_SUBMISSION_STATUSES):
        raise ValueError("该生没有已提交的答卷")
    requested_submission_id = payload.get("submission_id")
    if requested_submission_id is not None:
        bound_submission_id = _require_uuid(requested_submission_id, "submission_id")
        if bound_submission_id != submission.id:
            raise ValueError("submission_id 不是该生当前最新的有效提交")

    answer_candidates = list(
        session.scalars(
            select(AnswerAttempt)
            .where(AnswerAttempt.submission_id == submission.id)
            .order_by(AnswerAttempt.question_id, AnswerAttempt.attempt_number.desc(), AnswerAttempt.id.desc())
        )
    )
    answers_by_question: dict[UUID, AnswerAttempt] = {}
    for answer in answer_candidates:
        answers_by_question.setdefault(answer.question_id, answer)
    answers = list(answers_by_question.values())
    if not answers:
        raise ValueError("该生没有作答记录")
    by_question = {answer.question_id: answer for answer in answers}
    assignment_items = list(session.scalars(select(AssignmentItem).where(AssignmentItem.assignment_id == assignment_id)))
    max_score_by_question = {item.question_id: float(item.max_score) for item in assignment_items}
    snapshot_by_question = {
        item.question_id: item.question_snapshot if isinstance(item.question_snapshot, dict) else {}
        for item in assignment_items
    }
    only_answer = answers[0] if len(answers) == 1 else None
    written = 0
    skipped = 0
    seen_questions: set[UUID] = set()
    for raw in items:
        if not isinstance(raw, dict):
            raise ValueError("每个批改 item 必须是对象")
        question_id = _require_uuid(raw.get("question_id"), "question_id") if raw.get("question_id") else None
        answer = by_question.get(question_id) if question_id else only_answer
        if answer is None:
            raise ValueError("找不到对应题目的作答")
        if answer.question_id in seen_questions:
            raise ValueError("同一次写入不能重复批改同一道题")
        seen_questions.add(answer.question_id)
        max_score = max_score_by_question.get(answer.question_id)
        if max_score is None:
            raise ValueError("题目不属于当前作业")
        score = _required_finite_float(raw.get("score"), "score")
        if score < 0 or score > max_score:
            raise ValueError(f"score 必须在 0 到 {max_score:g} 之间")
        confidence = _optional_finite_float(raw.get("confidence"), "confidence")
        if confidence is not None and not 0 <= confidence <= 1:
            raise ValueError("confidence 必须在 0 到 1 之间")
        previous = session.scalar(
            select(GradingResult)
            .where(
                GradingResult.answer_attempt_id == answer.id,
                GradingResult.grader_type == "ai",
                GradingResult.voided_at.is_(None),
            )
            .order_by(GradingResult.created_at.desc())
        )
        if previous is not None:
            skipped += 1
            continue
        voided = session.scalar(
            select(GradingResult)
            .where(
                GradingResult.answer_attempt_id == answer.id,
                GradingResult.grader_type == "ai",
            )
            .order_by(GradingResult.created_at.desc())
        )
        session.add(
            GradingResult(
                answer_attempt_id=answer.id,
                grader_type="ai",
                score=score,
                feedback=str(raw.get("feedback") or "").strip() or None,
                rubric_result=_clean_rubric_result(
                    raw,
                    max_score=max_score,
                    snapshot=snapshot_by_question.get(answer.question_id),
                    overall_feedback=payload.get("overall_feedback"),
                ),
                confidence=confidence,
                model_name=str(payload.get("model_name") or "minerva-grader"),
                supersedes_id=None if voided is None else voided.id,
            )
        )
        written += 1
    if written == 0:
        return {
            "kind": "grading",
            "saved": 0,
            "skipped": skipped,
            "student_id": str(student_id),
            "finalized": False,
        }
    teacher = session.scalar(select(Teacher).where(Teacher.name == "本机教师"))
    session.add(
        AuditLog(
            actor_type="agent",
            actor_id=None if teacher is None else teacher.id,
            action="save_ai_grading",
            entity_type="submission",
            entity_id=submission.id,
            after_data={"student_id": str(student_id), "items": written, "skipped": skipped},
        )
    )
    session.commit()
    return {
        "kind": "grading",
        "saved": written,
        "skipped": skipped,
        "student_id": str(student_id),
        "finalized": False,
    }


def _finalize_grading(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    assignment_id = _require_uuid(payload.get("assignment_id"), "assignment_id")
    assignment = session.get(Assignment, assignment_id)
    if assignment is None:
        raise ValueError("作业不存在")
    items = list(session.scalars(select(AssignmentItem).where(AssignmentItem.assignment_id == assignment_id)))
    if not items:
        raise ValueError("作业没有题目")
    submission_candidates = list(
        session.scalars(
            select(Submission).where(
                Submission.assignment_id == assignment_id,
                Submission.status.in_(ACTIVE_SUBMISSION_STATUSES),
            ).order_by(Submission.student_id, Submission.attempt_number.desc(), Submission.id.desc())
        )
    )
    latest_by_student: dict[UUID, Submission] = {}
    for submission in submission_candidates:
        latest_by_student.setdefault(submission.student_id, submission)
    submissions = list(latest_by_student.values())
    if not submissions:
        raise ValueError("没有已提交学生，不能完成批改")
    missing: list[str] = []
    for submission in submissions:
        for item in items:
            answer = session.scalar(
                select(AnswerAttempt)
                .where(
                    AnswerAttempt.submission_id == submission.id,
                    AnswerAttempt.question_id == item.question_id,
                )
                .order_by(AnswerAttempt.attempt_number.desc())
            )
            if answer is None:
                missing.append(str(submission.student_id))
                break
            grading = session.scalar(
                select(GradingResult).where(
                    GradingResult.answer_attempt_id == answer.id,
                    GradingResult.grader_type == "ai",
                    GradingResult.voided_at.is_(None),
                )
            )
            if grading is None or grading.score is None:
                missing.append(str(submission.student_id))
                break
            score = float(grading.score)
            if not isfinite(score) or score < 0 or score > float(item.max_score):
                missing.append(str(submission.student_id))
                break
    if missing:
        raise ValueError(f"还有 {len(set(missing))} 名已提交学生未完成 AI 批改，不能 finalize")
    previous = assignment.status
    assignment.status = "graded"
    for submission in submissions:
        submission.status = "graded"
    session.add(
        AuditLog(
            actor_type="agent",
            action="finalize_assignment_grading",
            entity_type="assignment",
            entity_id=assignment.id,
            before_data={"status": previous},
            after_data={"status": "graded", "submissions": len(submissions)},
        )
    )
    session.commit()
    return {
        "kind": "grading",
        "finalized": True,
        "assignment_id": str(assignment_id),
        "status": "graded",
        "graded_submissions": len(submissions),
    }


def _observation_for(session: Session, student_id: UUID) -> StudentObservation:
    student = session.get(Student, student_id)
    if student is None:
        raise ValueError("学生不存在")
    row = session.get(StudentObservation, student_id)
    if row is None:
        row = StudentObservation(
            student_id=student_id,
            description={},
            evidence_buffer=[],
            teacher_fields=[],
        )
        session.add(row)
        session.flush()
    return row


def _save_student_description(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    student_id = _require_uuid(payload.get("student_id"), "student_id")
    fields = _clean_profile_fields(payload.get("fields"))
    row = _observation_for(session, student_id)
    current = _canonical_description(row.description)
    for key, value in fields.items():
        current[key] = value
    row.description = current
    authored_by = str(payload.get("authored_by") or "agent")
    teacher_fields = list(row.teacher_fields or [])
    if authored_by == "teacher":
        for key in fields:
            if key not in teacher_fields:
                teacher_fields.append(key)
        row.teacher_fields = teacher_fields
    assignment_id = payload.get("assignment_id")
    if assignment_id:
        row.last_assignment_id = _require_uuid(assignment_id, "assignment_id")
    session.add(
        AuditLog(
            actor_type="teacher" if authored_by == "teacher" else "agent",
            action="save_student_description",
            entity_type="student",
            entity_id=student_id,
            after_data={"fields": list(fields), "authored_by": authored_by},
        )
    )
    session.commit()
    return {
        "kind": "student_description",
        "student_id": str(student_id),
        "updated_fields": list(fields),
        "description": _json_value(row.description),
        "teacher_fields": list(row.teacher_fields or []),
    }


def _save_evidence_buffer(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    student_id = _require_uuid(payload.get("student_id"), "student_id")
    cleaned = _clean_evidence_buffer(payload.get("items"))
    assignment_id = payload.get("assignment_id")
    _hydrate_evidence_refs(
        session,
        student_id,
        cleaned,
        None if not assignment_id else _require_uuid(assignment_id, "assignment_id"),
    )
    row = _observation_for(session, student_id)
    row.evidence_buffer = cleaned
    if assignment_id:
        row.last_assignment_id = _require_uuid(assignment_id, "assignment_id")
    session.add(
        AuditLog(
            actor_type="agent",
            action="save_evidence_buffer",
            entity_type="student",
            entity_id=student_id,
            after_data={"items": len(cleaned)},
        )
    )
    session.commit()
    return {
        "kind": "evidence_buffer",
        "student_id": str(student_id),
        "items": _json_value(cleaned),
    }


def _assert_evaluator_scope(session: Session, assignment_id: UUID, student_id: UUID) -> None:
    valid_grade = session.scalar(
        select(GradingResult.id)
        .join(AnswerAttempt, AnswerAttempt.id == GradingResult.answer_attempt_id)
        .join(Submission, Submission.id == AnswerAttempt.submission_id)
        .where(
            Submission.assignment_id == assignment_id,
            Submission.student_id == student_id,
            GradingResult.grader_type == "ai",
            GradingResult.voided_at.is_(None),
        )
        .limit(1)
    )
    if valid_grade is None:
        raise ValueError("当前学生在该作业中没有有效 AI 批改结果")


def _grade_source_row(session: Session, grading_result_id: UUID):
    return session.execute(
        select(
            GradingResult.id,
            AnswerAttempt.id.label("answer_attempt_id"),
            AnswerAttempt.question_id,
            Submission.id.label("submission_id"),
            Submission.assignment_id,
            Submission.student_id,
        )
        .join(AnswerAttempt, AnswerAttempt.id == GradingResult.answer_attempt_id)
        .join(Submission, Submission.id == AnswerAttempt.submission_id)
        .where(
            GradingResult.id == grading_result_id,
            GradingResult.voided_at.is_(None),
        )
    ).mappings().one_or_none()


def _student_grade_ids(session: Session, student_id: UUID, assignment_id: UUID | None = None) -> list[str]:
    query = (
        select(GradingResult.id)
        .join(AnswerAttempt, AnswerAttempt.id == GradingResult.answer_attempt_id)
        .join(Submission, Submission.id == AnswerAttempt.submission_id)
        .where(
            Submission.student_id == student_id,
            GradingResult.grader_type == "ai",
            GradingResult.voided_at.is_(None),
        )
        .order_by(GradingResult.created_at.desc())
    )
    if assignment_id is not None:
        query = query.where(Submission.assignment_id == assignment_id)
    return [str(item) for item in session.scalars(query.limit(40))]


def _invalid_grade_message(session: Session, student_id: UUID, raw_id: Any, assignment_id: UUID | None = None) -> str:
    allowed = _student_grade_ids(session, student_id, assignment_id)
    extra = (
        f"当前学生可用的 grading_result_id：{', '.join(allowed)}"
        if allowed
        else "当前学生没有有效 AI 批改记录"
    )
    return f"grading_result_id 无效：{raw_id}。{extra}"


def _hydrate_evidence_refs(session: Session, student_id: UUID, value: Any, assignment_id: UUID | None = None) -> None:
    for ref in _iter_evidence_refs(value):
        raw_id = ref.get("grading_result_id")
        try:
            grading_result_id = _require_uuid(raw_id, "grading_result_id")
        except ValueError as error:
            raise ValueError(_invalid_grade_message(session, student_id, raw_id, assignment_id)) from error
        row = _grade_source_row(session, grading_result_id)
        if row is None or row["student_id"] != student_id:
            raise ValueError(_invalid_grade_message(session, student_id, raw_id, assignment_id))
        ref["grading_result_id"] = str(row["id"])
        ref["assignment_id"] = str(row["assignment_id"])
        ref["submission_id"] = str(row["submission_id"])
        ref["question_id"] = str(row["question_id"])
        ref["answer_attempt_id"] = str(row["answer_attempt_id"])


def _iter_evidence_refs(value: Any):
    if isinstance(value, list):
        for item in value:
            yield from _iter_evidence_refs(item)
        return
    if not isinstance(value, dict):
        return
    if "grading_result_id" in value:
        yield value
    for item in value.values():
        yield from _iter_evidence_refs(item)


def _validate_evidence_ownership(session: Session, student_id: UUID, value: Any, assignment_id: UUID | None = None) -> None:
    for ref in _iter_evidence_refs(value):
        raw_id = ref.get("grading_result_id")
        try:
            grading_result_id = _require_uuid(raw_id, "grading_result_id")
        except ValueError as error:
            raise ValueError(_invalid_grade_message(session, student_id, raw_id, assignment_id)) from error
        row = _grade_source_row(session, grading_result_id)
        if row is None or row["student_id"] != student_id:
            raise ValueError(_invalid_grade_message(session, student_id, raw_id, assignment_id))
        for field in ("assignment_id", "submission_id", "question_id", "answer_attempt_id"):
            if ref.get(field) is not None and _require_uuid(ref[field], field) != row[field]:
                raise ValueError(f"证据引用中的 {field} 与 grading_result 不一致")


def _validate_knowledge_ids(
    session: Session,
    assignment_id: UUID,
    current_description: dict[str, Any],
    profile_fields: dict[str, Any],
) -> None:
    knowledge_profile = profile_fields.get("knowledge_profile")
    if not isinstance(knowledge_profile, dict):
        return
    requested = set(knowledge_profile.get("knowledge_points", {}))
    existing = set(
        current_description.get("knowledge_profile", {}).get("knowledge_points", {})
        if isinstance(current_description.get("knowledge_profile"), dict)
        else {}
    )
    assignment_knowledge: set[str] = set()
    for item in session.scalars(select(AssignmentItem).where(AssignmentItem.assignment_id == assignment_id)):
        assignment_knowledge.update(_snapshot_knowledge_ids(item.question_snapshot if isinstance(item.question_snapshot, dict) else {}))
    unknown = requested - existing - assignment_knowledge
    if unknown:
        raise ValueError(f"knowledge_id 不在当前题目或既有学生描述中：{', '.join(sorted(unknown))}")


def _observation_diff(before: Any, after: Any, path: str = "") -> list[dict[str, Any]]:
    """JSON Pointer paths; arrays are atomic values so reordering stays unambiguous."""
    if before == after:
        return []
    if path == "/evidence_buffer":
        old = {str(item.get("candidate_id", f"legacy-{index}")): item for index, item in enumerate(before or [])}
        new = {str(item.get("candidate_id", f"legacy-{index}")): item for index, item in enumerate(after or [])}
        return [{"path": path + "/" + key.replace("~", "~0").replace("/", "~1"),
                 "operation": "add" if key not in old else "remove" if key not in new else "update",
                 "before": old.get(key), "after": new.get(key)}
                for key in sorted(old.keys() | new.keys()) if old.get(key) != new.get(key)]
    if isinstance(before, dict) and isinstance(after, dict):
        changes = []
        for key in sorted(before.keys() | after.keys()):
            child = path + "/" + key.replace("~", "~0").replace("/", "~1")
            if key in before and key in after:
                changes.extend(_observation_diff(before[key], after[key], child))
            else:
                changes.append({"path": child, "operation": "add" if key in after else "remove",
                                "before": before.get(key), "after": after.get(key)})
        return changes
    return [{"path": path, "operation": "update", "before": before, "after": after}]


def _attach_change_evidence(session: Session, student_id: UUID, changes: list[dict[str, Any]], notes: Any) -> None:
    if not isinstance(notes, list):
        raise ValueError("change_notes 必须提供每个实际变更的 path、reason 和 evidence_refs")
    indexed = {}
    for note in notes:
        if not isinstance(note, dict) or not isinstance(note.get("path"), str):
            raise ValueError("change_notes.path 必须是 JSON Pointer")
        if note["path"] in indexed:
            raise ValueError("change_notes.path 不能重复")
        indexed[note["path"]] = note
    if set(indexed) != {change["path"] for change in changes}:
        raise ValueError("change_notes.path 必须与实际变更一一对应：" + ", ".join(change["path"] for change in changes))
    for change in changes:
        note = indexed[change["path"]]
        reason = _clean_text(note.get("reason"), "change_notes.reason")
        refs = _clean_evidence_refs(note.get("evidence_refs"), "change_notes.evidence_refs")
        if not reason or not refs or any(not ref.get("grading_result_id") for ref in refs):
            raise ValueError("每个变更必须提供理由和包含 grading_result_id 的非空证据引用")
        _hydrate_evidence_refs(session, student_id, refs)
        _validate_evidence_ownership(session, student_id, refs)
        change.update(reason=reason, evidence_refs=refs)


def _decode_observation_path(path: Any) -> tuple[str, list[str]]:
    raw = _clean_text(path, "operations.path", required=True)
    if not raw.startswith("/"):
        raise ValueError("operations.path 必须是 JSON Pointer")
    try:
        parts = [item.replace("~1", "/").replace("~0", "~") for item in raw[1:].split("/")]
    except Exception as error:
        raise ValueError("operations.path 不是有效的 JSON Pointer") from error
    if any(not item for item in parts):
        raise ValueError("operations.path 不能包含空路径段")
    return raw, parts


def _clean_operation_evidence(
    session: Session,
    assignment_id: UUID,
    student_id: UUID,
    raw: Any,
) -> list[dict[str, Any]]:
    refs = _clean_evidence_refs(raw, "operations.evidence_refs")
    if not refs or any(not ref.get("grading_result_id") for ref in refs):
        raise ValueError("每个 observation operation 都必须引用本次作业的 grading_result_id")
    _hydrate_evidence_refs(session, student_id, refs, assignment_id)
    _validate_evidence_ownership(session, student_id, refs, assignment_id)
    if any(UUID(ref["assignment_id"]) != assignment_id for ref in refs):
        raise ValueError("observation operation 的证据必须来自本次作业")
    return refs


def _clean_operation_knowledge_point(
    session: Session,
    assignment_id: UUID,
    student_id: UUID,
    current_description: dict[str, Any],
    knowledge_id: str,
    value: Any,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("知识点 set operation 的 value 必须是对象")
    fields = _clean_profile_fields({
        "knowledge_profile": {"knowledge_points": {knowledge_id: value}},
    })
    _validate_knowledge_ids(session, assignment_id, current_description, fields)
    point = fields["knowledge_profile"]["knowledge_points"][knowledge_id]
    _hydrate_evidence_refs(session, student_id, point)
    _validate_evidence_ownership(session, student_id, point)
    return point


def _clean_profile_attribute_value(
    session: Session,
    student_id: UUID,
    section: str,
    attribute: str,
    value: Any,
) -> Any:
    allowed = (
        PROBLEM_SOLVING_ATTRIBUTES
        if section == "problem_solving_and_learning_profile"
        else TRAJECTORY_ATTRIBUTES
    )
    if attribute == "evidence_refs":
        cleaned = _clean_evidence_refs(value, f"{section}.evidence_refs")
        _hydrate_evidence_refs(session, student_id, cleaned)
        _validate_evidence_ownership(session, student_id, cleaned)
        return cleaned
    if attribute not in allowed:
        raise ValueError(f"{section} 不支持 observation operation 字段：{attribute}")
    return _clean_string_list(value, f"{section}.{attribute}")


def _apply_observation_operations(
    session: Session,
    assignment_id: UUID,
    student_id: UUID,
    current_description: dict[str, Any],
    current_buffer: list[dict[str, Any]],
    raw_operations: Any,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    if not isinstance(raw_operations, list):
        raise ValueError("operations 必须是数组")
    description = deepcopy(current_description)
    buffer_items = deepcopy(current_buffer)
    changes: list[dict[str, Any]] = []
    updated_fields: set[str] = set()
    seen_paths: set[str] = set()

    for raw in raw_operations:
        if not isinstance(raw, dict):
            raise ValueError("operations 中的每一项都必须是对象")
        path, parts = _decode_observation_path(raw.get("path"))
        if path in seen_paths:
            raise ValueError(f"operations.path 不能重复：{path}")
        seen_paths.add(path)
        operation = _clean_text(raw.get("op"), "operations.op", required=True)
        if operation not in {"set", "remove"}:
            raise ValueError("operations.op 只能是 set 或 remove")
        reason = _clean_text(raw.get("reason"), "operations.reason", required=True)
        evidence_refs = _clean_operation_evidence(
            session,
            assignment_id,
            student_id,
            raw.get("evidence_refs"),
        )
        before: Any
        after: Any
        changed_field: str | None = None

        if parts[:3] == ["description", "knowledge_profile", "knowledge_points"] and len(parts) == 4:
            knowledge_id = parts[3]
            points = description["knowledge_profile"]["knowledge_points"]
            before = deepcopy(points.get(knowledge_id))
            if operation == "remove":
                points.pop(knowledge_id, None)
                after = None
            else:
                after = _clean_operation_knowledge_point(
                    session,
                    assignment_id,
                    student_id,
                    current_description,
                    knowledge_id,
                    raw.get("value"),
                )
                points[knowledge_id] = after
            changed_field = "knowledge_profile"
        elif len(parts) == 3 and parts[0] == "description" and parts[1] in {
            "problem_solving_and_learning_profile",
            "learning_trajectory",
        }:
            if operation != "set":
                raise ValueError("画像数组字段只支持 set operation；清空时请把 value 设为 []")
            section, attribute = parts[1], parts[2]
            before = deepcopy(description[section].get(attribute))
            after = _clean_profile_attribute_value(
                session,
                student_id,
                section,
                attribute,
                raw.get("value"),
            )
            description[section][attribute] = after
            changed_field = section
        elif parts[0] == "evidence_buffer" and len(parts) == 2:
            candidate_id = parts[1]
            index = next(
                (index for index, item in enumerate(buffer_items) if str(item.get("candidate_id")) == candidate_id),
                None,
            )
            before = None if index is None else deepcopy(buffer_items[index])
            if operation == "remove":
                if index is not None:
                    buffer_items.pop(index)
                after = None
            else:
                cleaned = _clean_evidence_buffer([raw.get("value")])[0]
                if cleaned["candidate_id"] != candidate_id:
                    raise ValueError("Buffer operation 路径中的 candidate_id 必须与 value 一致")
                _hydrate_evidence_refs(session, student_id, cleaned)
                _validate_evidence_ownership(session, student_id, cleaned)
                after = cleaned
                if index is None:
                    buffer_items.append(cleaned)
                else:
                    buffer_items[index] = cleaned
        else:
            raise ValueError(
                "operations.path 只能指向单个知识点、两个学习画像的固定数组字段，或单个 Evidence Buffer 候选"
            )

        if before == after:
            continue
        if changed_field is not None:
            updated_fields.add(changed_field)
        changes.append({
            "path": path,
            "operation": "remove" if after is None else "add" if before is None else "update",
            "before": before,
            "after": deepcopy(after),
            "reason": reason,
            "evidence_refs": evidence_refs,
        })

    return description, buffer_items, changes, sorted(updated_fields)


def _assert_observation_version(
    row: StudentObservation,
    observation_existed: bool,
    payload: dict[str, Any],
) -> None:
    if "expected_observation_updated_at" not in payload:
        return
    expected_raw = payload.get("expected_observation_updated_at")
    if expected_raw is None:
        if observation_existed:
            raise ValueError("STUDENT_OBSERVATION_STALE：学生描述已在本次 Evaluator 输入固定后发生变化")
        return
    try:
        expected = datetime.fromisoformat(str(expected_raw).replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("expected_observation_updated_at 无效") from error
    actual = row.updated_at
    if actual is None or expected.tzinfo is None or actual.tzinfo is None or expected != actual:
        raise ValueError("STUDENT_OBSERVATION_STALE：学生描述已在本次 Evaluator 输入固定后发生变化")


def _save_student_observation(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    assignment_id = _require_uuid(payload.get("assignment_id"), "assignment_id")
    student_id = _require_uuid(payload.get("student_id"), "student_id")
    profile_fields_raw = payload.get("profile_fields")
    buffer_items_raw = payload.get("buffer_items")
    operations_raw = payload.get("operations")
    if operations_raw is not None and any(
        key in payload for key in ("profile_fields", "buffer_items", "change_notes")
    ):
        raise ValueError("operations 不能与 profile_fields、buffer_items 或 change_notes 混用")
    if operations_raw == [] and payload.get("evaluation_complete") is not True:
        raise ValueError("空 operations 只能用于确认评估完成")
    if operations_raw is None and profile_fields_raw in (None, {}) and buffer_items_raw is None and payload.get("evaluation_complete") is not True:
        raise ValueError("profile_fields 和 buffer_items 至少需要提供一项")
    _assert_evaluator_scope(session, assignment_id, student_id)
    observation_existed = session.get(StudentObservation, student_id) is not None
    row = _observation_for(session, student_id)
    # Serialize concurrent evaluator writes for an existing student observation.
    session.refresh(row, with_for_update=True)
    _assert_observation_version(row, observation_existed, payload)
    rollback_description = deepcopy(row.description)
    rollback_evidence_buffer = deepcopy(row.evidence_buffer)
    description = _canonical_description(row.description)
    before = {"description": deepcopy(description), "evidence_buffer": deepcopy(row.evidence_buffer)}
    before_last_assignment_id = None if row.last_assignment_id is None else str(row.last_assignment_id)
    if operations_raw is not None:
        description, next_buffer, changes, updated_fields = _apply_observation_operations(
            session,
            assignment_id,
            student_id,
            description,
            list(row.evidence_buffer or []),
            operations_raw,
        )
        buffer_items = next_buffer
    else:
        profile_fields = {} if profile_fields_raw in (None, {}) else _clean_profile_fields(profile_fields_raw)
        buffer_items = None if buffer_items_raw is None else _clean_evidence_buffer(buffer_items_raw)
        _hydrate_evidence_refs(session, student_id, profile_fields, assignment_id)
        if buffer_items is not None:
            _hydrate_evidence_refs(session, student_id, buffer_items, assignment_id)
        _validate_knowledge_ids(session, assignment_id, description, profile_fields)
        _validate_evidence_ownership(session, student_id, profile_fields, assignment_id)
        if buffer_items is not None:
            _validate_evidence_ownership(session, student_id, buffer_items, assignment_id)
        description.update(profile_fields)
        after_legacy = {"description": description, "evidence_buffer": row.evidence_buffer if buffer_items is None else buffer_items}
        changes = _observation_diff(before, after_legacy)
        _attach_change_evidence(session, student_id, changes, payload.get("change_notes"))
        updated_fields = list(profile_fields)
    after = {"description": description, "evidence_buffer": row.evidence_buffer if buffer_items is None else buffer_items}
    row.description = description
    if buffer_items is not None:
        row.evidence_buffer = buffer_items
    row.last_assignment_id = assignment_id
    session.add(
        AuditLog(
            actor_type="agent",
            action="save_student_observation",
            entity_type="student",
            entity_id=student_id,
            before_data={
                **deepcopy(before),
                "rollback_description": rollback_description,
                "rollback_evidence_buffer": rollback_evidence_buffer,
                "last_assignment_id": before_last_assignment_id,
                "observation_existed": observation_existed,
            },
            after_data={
                "schema_version": 2,
                **deepcopy(after),
                "last_assignment_id": str(assignment_id),
                "changes": changes,
                "assignment_id": str(assignment_id),
                "profile_fields": updated_fields,
                "buffer_items": None if buffer_items is None else len(buffer_items),
            },
        )
    )
    if payload.get("evaluation_complete") is True:
        from .assignment_summary import complete_evaluation
        session.flush()
        if "report_significance" not in payload:
            raise ValueError("评估完成必须提供 report_significance")
        complete_evaluation(
            session,
            assignment_id,
            student_id,
            description,
            evidence_buffer=row.evidence_buffer,
            report_significance=_clean_report_significance(payload.get("report_significance"), required=True),
        )
    session.commit()
    return {
        "kind": "student_observation",
        "student_id": str(student_id),
        "assignment_id": str(assignment_id),
        "updated_fields": updated_fields,
        "changes": changes,
        "description": _json_value(row.description),
        "buffer_items": _json_value(row.evidence_buffer),
    }


def _require_uuid(value: Any, field: str) -> UUID:
    try:
        return UUID(str(value))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} 无效") from error


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    return float(value)


def _required_finite_float(value: Any, field: str) -> float:
    if value is None or value == "" or isinstance(value, bool):
        raise ValueError(f"{field} 必须是阿拉伯数字")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} 必须是阿拉伯数字") from error
    if not isfinite(result):
        raise ValueError(f"{field} 必须是有限阿拉伯数字")
    return result


def _optional_finite_float(value: Any, field: str) -> float | None:
    if value is None or value == "":
        return None
    return _required_finite_float(value, field)
