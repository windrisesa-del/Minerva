from __future__ import annotations

import shutil
from pathlib import Path
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .assignment_import import UPLOADS_DIR
from .models import (
    AnswerAttempt,
    Assignment,
    AssignmentItem,
    AuditLog,
    GradingResult,
    Question,
    StudentObservation,
    Submission,
)


ADAPTER_RUNS_DIR = Path(__file__).resolve().parents[1] / ".data" / "adapter-runs"


def _rollback_evaluator_observations(session: Session, assignment_id: UUID) -> int:
    logs = list(session.scalars(
        select(AuditLog)
        .where(
            AuditLog.action == "save_student_observation",
            AuditLog.entity_type == "student",
            AuditLog.after_data["assignment_id"].astext == str(assignment_id),
        )
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    ))
    if not logs:
        return 0

    by_student: dict[UUID, list[AuditLog]] = {}
    for log in logs:
        by_student.setdefault(log.entity_id, []).append(log)

    for student_id, student_logs in by_student.items():
        row = session.scalar(
            select(StudentObservation).where(StudentObservation.student_id == student_id).with_for_update()
        )
        if row is None:
            raise ValueError("Evaluator 清理失败：学生描述记录已不存在")
        latest_after = student_logs[0].after_data or {}
        latest_assignment_id = latest_after.get("last_assignment_id")
        if (
            row.description != latest_after.get("description")
            or row.evidence_buffer != latest_after.get("evidence_buffer")
            or (None if row.last_assignment_id is None else str(row.last_assignment_id)) != latest_assignment_id
        ):
            raise ValueError("Evaluator 清理失败：学生描述在本次评估后又发生变化，已停止清理以免覆盖新数据")
        earliest_before = student_logs[-1].before_data or {}
        restore_description = earliest_before.get("rollback_description", earliest_before.get("description"))
        restore_buffer = earliest_before.get("rollback_evidence_buffer", earliest_before.get("evidence_buffer"))
        if not isinstance(restore_description, dict) or not isinstance(restore_buffer, list):
            raise ValueError("Evaluator 清理失败：缺少可恢复的学生描述快照")
        if earliest_before.get("observation_existed") is False:
            session.delete(row)
        else:
            row.description = restore_description
            row.evidence_buffer = restore_buffer
            previous_assignment = earliest_before.get("last_assignment_id")
            row.last_assignment_id = UUID(previous_assignment) if previous_assignment else None

    session.execute(delete(AuditLog).where(AuditLog.id.in_([log.id for log in logs])))
    session.flush()
    return len(logs)


def discard_imported_assignment(session: Session, assignment_id: UUID) -> dict[str, object]:
    assignment = session.get(Assignment, assignment_id)
    if assignment is None:
        raise ValueError("作业不存在")

    reverted_observation_writes = _rollback_evaluator_observations(session, assignment_id)

    question_ids = list(session.scalars(
        select(AssignmentItem.question_id).where(AssignmentItem.assignment_id == assignment_id)
    ))
    submission_ids = list(session.scalars(
        select(Submission.id).where(Submission.assignment_id == assignment_id)
    ))
    answer_ids = list(session.scalars(
        select(AnswerAttempt.id).where(AnswerAttempt.submission_id.in_(submission_ids))
    )) if submission_ids else []
    grading_ids = list(session.scalars(
        select(GradingResult.id).where(GradingResult.answer_attempt_id.in_(answer_ids))
    )) if answer_ids else []
    related_ids = [assignment_id, *submission_ids, *answer_ids, *grading_ids]

    if related_ids:
        session.execute(delete(AuditLog).where(AuditLog.entity_id.in_(related_ids)))
    if grading_ids:
        session.execute(delete(GradingResult).where(GradingResult.id.in_(grading_ids)))
    if answer_ids:
        session.execute(delete(AnswerAttempt).where(AnswerAttempt.id.in_(answer_ids)))
    if submission_ids:
        session.execute(delete(Submission).where(Submission.id.in_(submission_ids)))
    session.execute(delete(AssignmentItem).where(AssignmentItem.assignment_id == assignment_id))
    session.execute(delete(Assignment).where(Assignment.id == assignment_id))
    for question_id in question_ids:
        still_used = session.scalar(
            select(AssignmentItem.id).where(AssignmentItem.question_id == question_id).limit(1)
        )
        if still_used is None:
            session.execute(delete(Question).where(Question.id == question_id))
    session.commit()

    removed_paths: list[str] = []
    for path in (UPLOADS_DIR / "assignments" / str(assignment_id), ADAPTER_RUNS_DIR / str(assignment_id)):
        if path.exists():
            shutil.rmtree(path)
            removed_paths.append(str(path))
    return {
        "assignment_id": str(assignment_id),
        "discarded": True,
        "reverted_observation_writes": reverted_observation_writes,
        "removed_paths": removed_paths,
    }
