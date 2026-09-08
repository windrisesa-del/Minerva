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

WRITE_KINDS = {"grading", "student_description", "evidence_buffer", "student_observation"}


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


def _clean_evidence_refs(value: Any, field: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field} 必须是数组")
    cleaned: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError(f"{field} 中的证据引用必须是对象")
        ref = {
            key: str(raw[key]).strip()
            for key in ("assignment_id", "submission_id", "question_id", "answer_attempt_id", "grading_result_id")
            if raw.get(key) is not None and str(raw[key]).strip()
        }
        observed_at = _clean_text(raw.get("observed_at"), f"{field}.observed_at")
        if observed_at:
            ref["observed_at"] = observed_at
        if not ref:
            raise ValueError(f"{field} 中的证据引用不能为空")
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
            knowledge_points[knowledge_id] = {
                "knowledge_name": _clean_text(raw_point.get("knowledge_name") or knowledge_id, "knowledge_name", required=True),
                "mastery_level": mastery_level,
                "mastery_reason": _clean_text(raw_point.get("mastery_reason"), "mastery_reason"),
                "mastered_parts": _clean_string_list(raw_point.get("mastered_parts"), "mastered_parts"),
                "unmastered_parts": _clean_string_list(raw_point.get("unmastered_parts"), "unmastered_parts"),
                "mastery_boundaries": _clean_string_list(raw_point.get("mastery_boundaries"), "mastery_boundaries"),
                "common_errors": _clean_string_list(raw_point.get("common_errors"), "common_errors"),
                "evidence_refs": _clean_evidence_refs(raw_point.get("evidence_refs"), "knowledge_profile.evidence_refs"),
            }
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
                "source": _clean_evidence_refs([raw_item.get("source")], "evidence.source")[0],
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
                AND candidate.status IN ('submitted', 'graded')
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
                AND candidate.status IN ('submitted', 'graded')
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
                AND submission.status IN ('submitted', 'graded')
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
                AND candidate.status IN ('submitted', 'graded')
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
        raise ValueError("kind 必须是 grading、student_description、evidence_buffer 或 student_observation")
    if kind == "student_observation":
        return _save_student_observation(session, payload)
    if kind == "student_description":
        return _save_student_description(session, payload)
    if kind == "evidence_buffer":
        return _save_evidence_buffer(session, payload)
    if payload.get("finalize") is True:
        return _finalize_grading(session, payload)
    return _save_grading(session, payload)


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
            Submission.status.in_(("submitted", "graded")),
        )
        .order_by(Submission.attempt_number.desc(), Submission.id.desc())
    )
    if submission is None or submission.status not in {"submitted", "graded"}:
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
    max_score_by_question = {
        item.question_id: float(item.max_score)
        for item in session.scalars(select(AssignmentItem).where(AssignmentItem.assignment_id == assignment_id))
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
                rubric_result={
                    "is_correct": raw.get("is_correct"),
                    "max_score": max_score,
                    "overall_feedback": payload.get("overall_feedback"),
                },
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
                Submission.status.in_(("submitted", "graded")),
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
    row = _observation_for(session, student_id)
    row.evidence_buffer = cleaned
    assignment_id = payload.get("assignment_id")
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


def _validate_evidence_ownership(session: Session, student_id: UUID, value: Any) -> None:
    for ref in _iter_evidence_refs(value):
        grading_result_id = _require_uuid(ref.get("grading_result_id"), "grading_result_id")
        row = session.execute(
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
        if row is None or row["student_id"] != student_id:
            raise ValueError("证据引用不属于当前学生或已失效")
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
        snapshot = item.question_snapshot if isinstance(item.question_snapshot, dict) else {}
        points = snapshot.get("knowledge_points")
        if isinstance(points, list):
            assignment_knowledge.update(str(point).strip() for point in points if str(point).strip())
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
        _validate_evidence_ownership(session, student_id, refs)
        change.update(reason=reason, evidence_refs=refs)


def _save_student_observation(session: Session, payload: dict[str, Any]) -> dict[str, Any]:
    assignment_id = _require_uuid(payload.get("assignment_id"), "assignment_id")
    student_id = _require_uuid(payload.get("student_id"), "student_id")
    profile_fields_raw = payload.get("profile_fields")
    buffer_items_raw = payload.get("buffer_items")
    if profile_fields_raw in (None, {}) and buffer_items_raw is None and payload.get("evaluation_complete") is not True:
        raise ValueError("profile_fields 和 buffer_items 至少需要提供一项")
    _assert_evaluator_scope(session, assignment_id, student_id)
    profile_fields = {} if profile_fields_raw in (None, {}) else _clean_profile_fields(profile_fields_raw)
    buffer_items = None if buffer_items_raw is None else _clean_evidence_buffer(buffer_items_raw)
    observation_existed = session.get(StudentObservation, student_id) is not None
    row = _observation_for(session, student_id)
    # Serialize concurrent evaluator writes for an existing student observation.
    session.refresh(row, with_for_update=True)
    rollback_description = deepcopy(row.description)
    rollback_evidence_buffer = deepcopy(row.evidence_buffer)
    description = _canonical_description(row.description)
    _validate_knowledge_ids(session, assignment_id, description, profile_fields)
    _validate_evidence_ownership(session, student_id, profile_fields)
    if buffer_items is not None:
        _validate_evidence_ownership(session, student_id, buffer_items)
    before = {"description": deepcopy(description), "evidence_buffer": deepcopy(row.evidence_buffer)}
    before_last_assignment_id = None if row.last_assignment_id is None else str(row.last_assignment_id)
    description.update(profile_fields)
    after = {"description": description, "evidence_buffer": row.evidence_buffer if buffer_items is None else buffer_items}
    changes = _observation_diff(before, after)
    _attach_change_evidence(session, student_id, changes, payload.get("change_notes"))
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
                "profile_fields": list(profile_fields),
                "buffer_items": None if buffer_items is None else len(buffer_items),
            },
        )
    )
    if payload.get("evaluation_complete") is True:
        from .assignment_summary import complete_evaluation
        session.flush()
        complete_evaluation(session, assignment_id, student_id, description)
    session.commit()
    return {
        "kind": "student_observation",
        "student_id": str(student_id),
        "assignment_id": str(assignment_id),
        "updated_fields": list(profile_fields),
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
