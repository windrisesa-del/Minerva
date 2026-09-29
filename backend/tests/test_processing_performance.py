"""Isolated ORM tests: no configured database, real student records or API startup."""
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from sqlalchemy import JSON, MetaData, create_engine, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from app.minerva_tools import assignment_processing_state
from app.models import (
    AnswerAttempt, Assignment, AssignmentItem, Base, ClassRoom,
    EvaluationReceipt, GradingResult, Question, Student, Submission, Teacher,
)


@pytest.fixture
def dataset():
    engine = create_engine("sqlite:///:memory:")
    # Copy metadata: keep production PostgreSQL types unchanged.
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        copy = table.to_metadata(metadata)
        for column in copy.columns:
            if isinstance(column.type, JSONB):
                column.type = JSON()
    metadata.create_all(engine)
    with Session(engine) as session:
        teacher = Teacher(name="synthetic")
        session.add(teacher)
        session.flush()
        classroom = ClassRoom(teacher_id=teacher.id, name="synthetic")
        session.add(classroom)
        session.flush()
        assignment = Assignment(class_id=classroom.id, created_by=teacher.id, title="synthetic", status="grading")
        session.add(assignment)
        session.flush()
        questions = [Question(question_type="single_choice", stem="synthetic") for _ in range(12)]
        session.add_all(questions)
        session.flush()
        for index, question in enumerate(questions):
            session.add(AssignmentItem(assignment_id=assignment.id, question_id=question.id, position=index + 1, max_score=10, question_snapshot={}))
        ids = []
        for index in range(40):
            student = Student(name=f"student-{index:02}")
            session.add(student)
            session.flush()
            submission = Submission(assignment_id=assignment.id, student_id=student.id, status="submitted")
            session.add(submission)
            session.flush()
            ids.append((student.id, submission.id))
            for question in questions:
                answer = AnswerAttempt(submission_id=submission.id, student_id=student.id, question_id=question.id, answer_payload={})
                session.add(answer)
                session.flush()
                session.add(GradingResult(answer_attempt_id=answer.id, grader_type="ai", score=10))
        session.commit()
        assignment_id = assignment.id
        question_id = questions[0].id
    yield engine, assignment_id, ids, question_id
    engine.dispose()


def test_scoped_progress_matches_full_result_with_fewer_queries(dataset):
    engine, assignment_id, ids, _ = dataset
    queries = []
    def count(_conn, _cursor, statement, _params, _context, _many):
        queries.append(statement)
    event.listen(engine, "before_cursor_execute", count)
    try:
        with Session(engine) as session:
            full = assignment_processing_state(session, assignment_id)
        full_count = len(queries)
        queries.clear()
        with Session(engine) as session:
            scoped = assignment_processing_state(session, assignment_id, student_id=ids[0][0])
        scoped_count = len(queries)
        assert len(full["students"]) == 40
        assert scoped["students"] == [full["students"][0]]
        assert scoped["students"][0]["grading_complete"] is True
        assert scoped_count * 20 < full_count
        print(f"\n40 students x 12 questions: full={full_count} SQL; scoped={scoped_count} SQL")
    finally:
        event.remove(engine, "before_cursor_execute", count)


def test_scoped_progress_keeps_latest_submission_and_receipt_checks(dataset):
    engine, assignment_id, ids, _ = dataset
    student_id, old_id = ids[0]
    with Session(engine) as session:
        newer = Submission(assignment_id=assignment_id, student_id=student_id, attempt_number=2, status="submitted")
        session.add(newer)
        session.add(EvaluationReceipt(assignment_id=assignment_id, student_id=student_id, submission_id=old_id, snapshot={}))
        session.commit()
        result = assignment_processing_state(session, assignment_id, student_id=student_id)
        assert result["students"][0]["submission_id"] == str(newer.id)
        assert result["students"][0]["grading_complete"] is False
        assert result["students"][0]["evaluation_complete"] is False


@pytest.mark.parametrize("invalid_grade", ["voided", "teacher", "missing"])
def test_scoped_progress_does_not_accept_invalid_grades(dataset, invalid_grade):
    engine, assignment_id, ids, _ = dataset
    from sqlalchemy import select
    with Session(engine) as session:
        grade = session.scalar(select(GradingResult).join(AnswerAttempt).where(AnswerAttempt.submission_id == ids[0][1]))
        if invalid_grade == "voided":
            grade.voided_at = datetime.now(timezone.utc)
        elif invalid_grade == "teacher":
            grade.grader_type = "teacher"
        else:
            session.delete(grade)
        session.commit()
        result = assignment_processing_state(session, assignment_id, student_id=ids[0][0])
        assert result["students"][0]["grading_complete"] is False


def test_scoped_progress_cannot_return_a_foreign_student(dataset):
    engine, assignment_id, _, _ = dataset
    with Session(engine) as session:
        assert assignment_processing_state(session, assignment_id, student_id=uuid4())["students"] == []
        with pytest.raises(ValueError, match="作业不存在"):
            assignment_processing_state(session, uuid4(), student_id=uuid4())


def test_processing_http_route_passes_and_validates_student_scope(monkeypatch):
    from fastapi.testclient import TestClient
    from app import main
    from app.db import get_session

    calls = []
    def read(_session, assignment_id, *, student_id=None):
        calls.append((assignment_id, student_id))
        return {"assignment_id": str(assignment_id), "students": []}
    monkeypatch.setattr(main, "assignment_processing_state", read)
    main.app.dependency_overrides[get_session] = lambda: object()
    try:
        # Do not enter TestClient as a context manager: that starts the live DB.
        client = TestClient(main.app)
        assignment_id, student_id = uuid4(), uuid4()
        path = f"/api/assignments/{assignment_id}/processing"
        assert client.get(path, params={"student_id": str(student_id)}).status_code == 200
        assert calls[-1] == (assignment_id, student_id)
        assert client.get(path).status_code == 200
        assert calls[-1] == (assignment_id, None)
        assert client.get(path, params={"student_id": "invalid"}).status_code == 422
        assert len(calls) == 2
        client.close()
    finally:
        main.app.dependency_overrides.pop(get_session, None)
