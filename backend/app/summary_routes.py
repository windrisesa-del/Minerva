from typing import Any
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session
from .db import get_session
from .models import AssignmentSummary, EvaluationReceipt
from .assignment_summary import prepare_summary, report_json, save_narrative

router = APIRouter()


@router.get("/api/assignments/{assignment_id}/summary")
def get_report(assignment_id: UUID, session: Session = Depends(get_session)):
    report = session.scalar(select(AssignmentSummary).where(AssignmentSummary.assignment_id == assignment_id).order_by(AssignmentSummary.created_at.desc()))
    return {"report": report_json(report) if report else None}


@router.post("/api/assignments/{assignment_id}/summary/prepare")
def prepare(assignment_id: UUID, session: Session = Depends(get_session)):
    try:
        report = prepare_summary(session, assignment_id)
        session.commit()
        return report_json(report, include_context=True)
    except ValueError as error:
        session.rollback()
        raise HTTPException(409, str(error)) from error


@router.get("/api/assignments/{assignment_id}/evaluation/{student_id}")
def receipt(assignment_id: UUID, student_id: UUID, session: Session = Depends(get_session)):
    row = session.get(EvaluationReceipt, (assignment_id, student_id))
    return {"completed": row is not None, "submission_id": str(row.submission_id) if row else None}


@router.get("/api/summary/{report_id}/input")
def read_input(report_id: UUID, resource: str, student_id: UUID | None = None, offset: int = Query(0, ge=0), limit: int = Query(10, ge=1, le=25), session: Session = Depends(get_session)):
    report = session.get(AssignmentSummary, report_id)
    if report is None:
        raise HTTPException(404, "报告不存在")
    if resource == "statistics":
        return {"statistics": report.snapshot["statistics"], "items": report.snapshot["items"], "title": report.snapshot["title"]}
    if resource == "evidence":
        student = next((s for s in report.snapshot["students"] if s["student_id"] == str(student_id)), None)
        if student is None:
            raise HTTPException(400, "学生不在本报告范围")
        rows = student["grades"][offset:offset + limit]
        more = offset + len(rows) < len(student["grades"])
        return {"records": rows, "has_more": more, "next_offset": offset + len(rows) if more else None}
    if resource != "students":
        raise HTTPException(400, "只允许 statistics、students 或 evidence")
    students = report.snapshot["students"]
    rows = [{k: v for k, v in s.items() if k != "grades"} for s in students[offset:offset + limit]]
    return {"records": rows, "has_more": offset + len(rows) < len(students),
            "next_offset": offset + len(rows) if offset + len(rows) < len(students) else None}


@router.post("/api/summary/{report_id}")
def write_report(report_id: UUID, payload: dict[str, Any], session: Session = Depends(get_session)):
    report = session.scalar(select(AssignmentSummary).where(AssignmentSummary.id == report_id).with_for_update())
    if report is None:
        raise HTTPException(404, "报告不存在")
    try:
        if "narrative" in payload:
            save_narrative(session, report, payload["narrative"])
        elif report.status != "completed" and payload.get("status") in {"running", "failed"}:
            report.status = payload["status"]
            report.last_error = str(payload.get("error") or "")[:2000] or None
        else:
            raise ValueError("报告状态不可更改")
        session.commit()
        return report_json(report)
    except ValueError as error:
        session.rollback()
        raise HTTPException(400, str(error)) from error
