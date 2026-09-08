from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .assignment_import import IncomingFile, collect_zip_files, import_ungraded_assignment
from .assignment_cleanup import discard_imported_assignment
from .assessment_adapter import apply_adapter_assessment
from .db import get_session, initialize_database
from .document_parser import parse_uploaded_document
from .minerva_tools import read_minerva, write_minerva
from .models import Assignment, AuditLog, Teacher
from .student_roster import StudentSyncIn, upsert_students


APP_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(
    title="Minerva 学习数据 API",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url=None,
)
uploads_dir = APP_DIR.parent / ".data" / "uploads"
uploads_dir.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=uploads_dir), name="uploads")


@app.get("/api/health")
def health(session: Session = Depends(get_session)):
    row = session.execute(
        text("SELECT current_database() AS database, version() AS version")
    ).mappings().one()
    return {"status": "ok", "database": row["database"], "version": row["version"]}


@app.get("/api/overview")
def overview(session: Session = Depends(get_session)):
    row = session.execute(
        text(
            """
            SELECT
              (SELECT count(*) FROM students WHERE status = 'active') AS students,
              (SELECT count(DISTINCT c.id)
                 FROM classes c
                 JOIN enrollments e ON e.class_id = c.id AND e.left_at IS NULL
                WHERE c.status = 'active') AS classes,
              (SELECT count(*) FROM assignments) AS assignments,
              (SELECT count(*) FROM answer_attempts) AS answers,
              (SELECT round(avg(CASE WHEN is_correct THEN 100.0 ELSE 0.0 END), 1)
                 FROM answer_attempts WHERE is_correct IS NOT NULL) AS accuracy
            """
        )
    ).mappings().one()
    return dict(row)


@app.put("/api/students/sync")
def sync_students(records: list[StudentSyncIn], session: Session = Depends(get_session)):
    try:
        upserted = upsert_students(session, records)
    except ValueError as error:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"upserted": upserted}


@app.get("/api/students")
def students(
    search: str = Query(default="", max_length=120),
    session: Session = Depends(get_session),
):
    rows = session.execute(
        text(
            """
            SELECT
              s.id,
              s.name,
              s.student_number,
              COALESCE(c.name, '未分班') AS class_name,
              COALESCE(e.group_name, '') AS group_name,
              count(a.id)::int AS answer_count,
              count(a.id) FILTER (WHERE a.is_correct)::int AS correct_count,
              CASE
                WHEN count(a.id) FILTER (WHERE a.is_correct IS NOT NULL) = 0 THEN NULL
                ELSE round(
                  count(a.id) FILTER (WHERE a.is_correct)::numeric * 100 /
                  count(a.id) FILTER (WHERE a.is_correct IS NOT NULL), 1
                )
              END AS accuracy,
              s.updated_at
            FROM students s
            LEFT JOIN enrollments e ON e.student_id = s.id AND e.left_at IS NULL
            LEFT JOIN classes c ON c.id = e.class_id
            LEFT JOIN answer_attempts a ON a.student_id = s.id
            WHERE s.status = 'active'
              AND (:search = '' OR s.name ILIKE :pattern OR COALESCE(s.student_number, '') ILIKE :pattern)
            GROUP BY s.id, c.name, e.group_name
            ORDER BY s.name
            LIMIT 200
            """
        ),
        {"search": search.strip(), "pattern": f"%{search.strip()}%"},
    ).mappings()
    return [dict(row) for row in rows]


@app.get("/api/answers/recent")
def recent_answers(
    limit: int = Query(default=8, ge=1, le=50),
    session: Session = Depends(get_session),
):
    rows = session.execute(
        text(
            """
            SELECT
              a.id,
              s.name AS student_name,
              q.stem AS question,
              ass.title AS assignment_title,
              a.is_correct,
              a.objective_score,
              a.answered_at
            FROM answer_attempts a
            JOIN students s ON s.id = a.student_id
            JOIN questions q ON q.id = a.question_id
            JOIN submissions sub ON sub.id = a.submission_id
            JOIN assignments ass ON ass.id = sub.assignment_id
            ORDER BY a.answered_at DESC
            LIMIT :limit
            """
        ),
        {"limit": limit},
    ).mappings()
    return [dict(row) for row in rows]


ASSIGNMENT_METRICS_SQL = """
WITH latest_submissions AS (
  SELECT DISTINCT ON (submission.assignment_id, submission.student_id)
    submission.id,
    submission.assignment_id,
    submission.student_id,
    submission.status,
    submission.started_at,
    submission.submitted_at,
    submission.attempt_number
  FROM submissions submission
  ORDER BY submission.assignment_id, submission.student_id, submission.attempt_number DESC
),
latest_answers AS (
  SELECT DISTINCT ON (answer.submission_id, answer.question_id)
    answer.id,
    answer.submission_id,
    answer.is_correct,
    answer.objective_score
  FROM answer_attempts answer
  ORDER BY answer.submission_id, answer.question_id, answer.attempt_number DESC
),
submission_scores AS (
  SELECT
    latest.id,
    latest.assignment_id,
    latest.student_id,
    latest.status,
    latest.started_at,
    latest.submitted_at,
    latest.attempt_number,
    count(answer.id)::int AS answered_questions,
    count(answer.id) FILTER (WHERE answer.is_correct)::int AS correct_answers,
    count(answer.id) FILTER (WHERE answer.is_correct IS NOT NULL)::int AS objective_answers,
    sum(COALESCE(grade.score, answer.objective_score)) AS score
  FROM latest_submissions latest
  LEFT JOIN latest_answers answer ON answer.submission_id = latest.id
  LEFT JOIN LATERAL (
    SELECT grading.score
    FROM grading_results grading
    WHERE grading.answer_attempt_id = answer.id
      AND grading.voided_at IS NULL
    ORDER BY grading.created_at DESC
    LIMIT 1
  ) grade ON true
  GROUP BY latest.id, latest.assignment_id, latest.student_id, latest.status,
           latest.started_at, latest.submitted_at, latest.attempt_number
),
item_stats AS (
  SELECT
    item.assignment_id,
    count(*)::int AS item_count,
    COALESCE(sum(item.max_score), 0) AS max_score
  FROM assignment_items item
  GROUP BY item.assignment_id
),
enrollment_stats AS (
  SELECT enrollment.class_id, count(*)::int AS student_count
  FROM enrollments enrollment
  JOIN students student ON student.id = enrollment.student_id AND student.status = 'active'
  WHERE enrollment.left_at IS NULL
  GROUP BY enrollment.class_id
),
submission_stats AS (
  SELECT
    score.assignment_id,
    count(*)::int AS submission_count,
    count(*) FILTER (WHERE score.status IN ('submitted', 'graded'))::int AS completed_count,
    round(avg(score.score) FILTER (WHERE score.status IN ('submitted', 'graded')), 1) AS average_score
  FROM submission_scores score
  GROUP BY score.assignment_id
)
SELECT
  assignment.id,
  assignment.title,
  assignment.status,
  assignment.published_at,
  assignment.due_at,
  assignment.created_at,
  classroom.id AS class_id,
  classroom.name AS class_name,
  COALESCE(items.item_count, 0)::int AS item_count,
  COALESCE(items.max_score, 0) AS max_score,
  COALESCE(enrollments.student_count, 0)::int AS student_count,
  COALESCE(submissions.submission_count, 0)::int AS submission_count,
  COALESCE(submissions.completed_count, 0)::int AS completed_count,
  CASE
    WHEN COALESCE(enrollments.student_count, 0) = 0 THEN 0
    ELSE round(COALESCE(submissions.completed_count, 0)::numeric * 100 / enrollments.student_count, 1)
  END AS completion_rate,
  submissions.average_score
FROM assignments assignment
JOIN classes classroom ON classroom.id = assignment.class_id
LEFT JOIN item_stats items ON items.assignment_id = assignment.id
LEFT JOIN enrollment_stats enrollments ON enrollments.class_id = assignment.class_id
LEFT JOIN submission_stats submissions ON submissions.assignment_id = assignment.id
"""


@app.get("/api/classes")
def classes(session: Session = Depends(get_session)):
    rows = session.execute(
        text(
            """
            SELECT
              classroom.id,
              classroom.name,
              classroom.status,
              count(enrollment.id) FILTER (
                WHERE enrollment.left_at IS NULL AND student.status = 'active'
              )::int AS student_count
            FROM classes classroom
            LEFT JOIN enrollments enrollment ON enrollment.class_id = classroom.id
            LEFT JOIN students student ON student.id = enrollment.student_id
            WHERE classroom.status = 'active'
            GROUP BY classroom.id
            ORDER BY classroom.name
            """
        )
    ).mappings()
    return [dict(row) for row in rows]


@app.post("/api/assignments/import")
async def import_assignment(
    title: str = Form(...),
    class_id: UUID | None = Form(default=None),
    archive: UploadFile | None = File(default=None),
    files: list[UploadFile] | None = File(default=None),
    session: Session = Depends(get_session),
):
    incoming: list[IncomingFile] = []
    uploads = [item for item in [archive, *(files or [])] if item is not None]
    for upload in uploads:
        if not upload.filename:
            continue
        payload = await upload.read()
        if upload.filename.lower().endswith(".zip"):
            try:
                incoming.extend(collect_zip_files(payload))
            except ValueError as error:
                raise HTTPException(status_code=400, detail=str(error)) from error
            continue
        incoming.append(
            IncomingFile(
                original_name=Path(upload.filename).name,
                content=payload,
                relative_path=upload.filename.replace("\\", "/"),
            )
        )
    try:
        return import_ungraded_assignment(
            session,
            title=title,
            class_id=class_id,
            files=incoming,
        )
    except ValueError as error:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.get("/api/assignments")
def assignments(session: Session = Depends(get_session)):
    rows = session.execute(
        text(
            ASSIGNMENT_METRICS_SQL
            + """
            ORDER BY
              CASE assignment.status
                WHEN 'ungraded' THEN 0
                WHEN 'draft' THEN 1
                WHEN 'graded' THEN 2
                WHEN 'archived' THEN 3
                ELSE 4
              END,
              assignment.due_at NULLS LAST,
              assignment.created_at DESC
            """
        )
    ).mappings()
    assignment_rows = [dict(row) for row in rows]
    active_rows = [row for row in assignment_rows if row["status"] != "archived"]

    completed = sum(int(row["completed_count"]) for row in active_rows)
    possible = sum(int(row["student_count"]) for row in active_rows)
    scored = [row["average_score"] for row in active_rows if row["average_score"] is not None]
    average_score = round(sum(scored) / len(scored), 1) if scored else None

    return {
        "summary": {
            "assignment_count": len(active_rows),
            "archived_count": len(assignment_rows) - len(active_rows),
            "published_count": sum(row["status"] == "ungraded" for row in active_rows),
            "ungraded_count": sum(row["status"] == "ungraded" for row in active_rows),
            "graded_count": sum(row["status"] == "graded" for row in active_rows),
            "completed_submissions": completed,
            "expected_submissions": possible,
            "overall_completion_rate": round(completed * 100 / possible, 1) if possible else 0,
            "average_score": average_score,
        },
        "assignments": assignment_rows,
    }


class AssignmentPatch(BaseModel):
    status: str


class DocumentParseRequest(BaseModel):
    path: str


@app.patch("/api/assignments/{assignment_id}")
def patch_assignment(
    assignment_id: UUID,
    body: AssignmentPatch,
    session: Session = Depends(get_session),
):
    allowed = {"draft", "ungraded", "graded", "archived"}
    if body.status not in allowed:
        raise HTTPException(status_code=400, detail="不支持的作业状态")
    assignment = session.get(Assignment, assignment_id)
    if assignment is None:
        raise HTTPException(status_code=404, detail="作业不存在")
    previous = assignment.status
    assignment.status = body.status
    teacher = session.scalar(select(Teacher).where(Teacher.name == "本机教师"))
    session.add(
        AuditLog(
            actor_type="teacher",
            actor_id=None if teacher is None else teacher.id,
            action="archive_assignment" if body.status == "archived" else "update_assignment_status",
            entity_type="assignment",
            entity_id=assignment.id,
            before_data={"status": previous},
            after_data={"status": body.status},
        )
    )
    session.commit()
    return {"id": str(assignment.id), "status": assignment.status, "previous_status": previous}


@app.delete("/api/assignments/{assignment_id}")
def discard_assignment(assignment_id: UUID, session: Session = Depends(get_session)):
    try:
        return discard_imported_assignment(session, assignment_id)
    except ValueError as error:
        session.rollback()
        message = str(error)
        raise HTTPException(status_code=404 if message == "作业不存在" else 409, detail=message) from error


@app.get("/api/assignments/{assignment_id}")
def assignment_detail(assignment_id: UUID, session: Session = Depends(get_session)):
    assignment = session.execute(
        text(ASSIGNMENT_METRICS_SQL + " WHERE assignment.id = :assignment_id"),
        {"assignment_id": assignment_id},
    ).mappings().one_or_none()
    if assignment is None:
        raise HTTPException(status_code=404, detail="作业不存在")

    students = session.execute(
        text(
            """
            WITH latest_submission AS (
              SELECT DISTINCT ON (submission.student_id)
                submission.id,
                submission.student_id,
                submission.status,
                submission.started_at,
                submission.submitted_at,
                submission.attempt_number
              FROM submissions submission
              WHERE submission.assignment_id = :assignment_id
              ORDER BY submission.student_id, submission.attempt_number DESC
            ),
            latest_answers AS (
              SELECT DISTINCT ON (answer.submission_id, answer.question_id)
                answer.id,
                answer.submission_id,
                answer.is_correct,
                answer.objective_score
              FROM answer_attempts answer
              JOIN latest_submission latest ON latest.id = answer.submission_id
              ORDER BY answer.submission_id, answer.question_id, answer.attempt_number DESC
            ),
            answer_stats AS (
              SELECT
                latest.id AS submission_id,
                count(answer.id)::int AS answered_questions,
                count(answer.id) FILTER (WHERE answer.is_correct)::int AS correct_answers,
                count(answer.id) FILTER (WHERE answer.is_correct IS NOT NULL)::int AS objective_answers,
                sum(COALESCE(grade.score, answer.objective_score)) AS score
              FROM latest_submission latest
              LEFT JOIN latest_answers answer ON answer.submission_id = latest.id
              LEFT JOIN LATERAL (
                SELECT grading.score
                FROM grading_results grading
                WHERE grading.answer_attempt_id = answer.id
                  AND grading.voided_at IS NULL
                ORDER BY grading.created_at DESC
                LIMIT 1
              ) grade ON true
              GROUP BY latest.id
            ),
            item_stats AS (
              SELECT count(*)::int AS total_questions, COALESCE(sum(max_score), 0) AS max_score
              FROM assignment_items
              WHERE assignment_id = :assignment_id
            )
            SELECT
              student.id,
              student.name,
              student.student_number,
              COALESCE(enrollment.group_name, '') AS group_name,
              COALESCE(latest.status, 'not_started') AS submission_status,
              latest.attempt_number,
              latest.started_at,
              latest.submitted_at,
              COALESCE(answer.answered_questions, 0)::int AS answered_questions,
              items.total_questions,
              COALESCE(answer.correct_answers, 0)::int AS correct_answers,
              CASE
                WHEN COALESCE(answer.objective_answers, 0) = 0 THEN NULL
                ELSE round(answer.correct_answers::numeric * 100 / answer.objective_answers, 1)
              END AS accuracy,
              CASE WHEN latest.id IS NULL THEN NULL ELSE answer.score END AS score,
              items.max_score
            FROM assignments assignment
            JOIN enrollments enrollment
              ON enrollment.class_id = assignment.class_id AND enrollment.left_at IS NULL
            JOIN students student ON student.id = enrollment.student_id AND student.status = 'active'
            LEFT JOIN latest_submission latest ON latest.student_id = student.id
            LEFT JOIN answer_stats answer ON answer.submission_id = latest.id
            CROSS JOIN item_stats items
            WHERE assignment.id = :assignment_id
            ORDER BY
              CASE COALESCE(latest.status, 'not_started')
                WHEN 'submitted' THEN 0 WHEN 'graded' THEN 1 WHEN 'draft' THEN 2 ELSE 3
              END,
              student.name
            """
        ),
        {"assignment_id": assignment_id},
    ).mappings()

    return {"assignment": dict(assignment), "students": [dict(row) for row in students]}


@app.post("/api/document/parse")
def document_parse(body: DocumentParseRequest):
    try:
        return parse_uploaded_document(body.path)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/assignments/{assignment_id}/assessment")
def save_adapter_assessment(
    assignment_id: UUID,
    body: dict[str, Any],
    session: Session = Depends(get_session),
):
    try:
        return apply_adapter_assessment(session, assignment_id, body)
    except ValueError as error:
        session.rollback()
        status = 404 if str(error) == "作业不存在" else 400
        raise HTTPException(status_code=status, detail=str(error)) from error


@app.get("/api/minerva/read")
def minerva_read(
    resource: str,
    id: UUID | None = None,
    assignment_id: UUID | None = None,
    student_id: UUID | None = None,
    submission_id: UUID | None = None,
    question_id: UUID | None = None,
    status: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    include_private: bool = False,
    include_voided: bool = False,
    grader_type: str | None = None,
    session: Session = Depends(get_session),
):
    try:
        return read_minerva(
            session,
            resource=resource,
            id=id,
            assignment_id=assignment_id,
            student_id=student_id,
            submission_id=submission_id,
            question_id=question_id,
            status=status,
            limit=limit,
            offset=offset,
            include_private=include_private,
            include_voided=include_voided,
            grader_type=grader_type,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@app.post("/api/minerva/write")
def minerva_write(payload: dict[str, Any], session: Session = Depends(get_session)):
    try:
        return write_minerva(session, payload)
    except ValueError as error:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(error)) from error


from .summary_routes import router as summary_router
app.include_router(summary_router)
