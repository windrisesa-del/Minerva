"""Pure regression checks for model-facing grade-ID-only evidence references."""
from uuid import uuid4

import pytest

from app import minerva_tools


def test_compact_current_and_historical_refs_hydrate_without_database(monkeypatch):
    student = uuid4()
    rows = [{key: uuid4() for key in ("id", "assignment_id", "submission_id", "question_id", "answer_attempt_id")}
            for _ in range(2)]
    for row in rows:
        row["student_id"] = student
    by_id = {row["id"]: row for row in rows}
    monkeypatch.setattr(minerva_tools, "_grade_source_row", lambda _session, grade: by_id.get(grade))
    refs = [{"grading_result_id": str(row["id"])} for row in rows]
    minerva_tools._hydrate_evidence_refs(None, student, refs)
    for ref, row in zip(refs, rows):
        assert ref == {"grading_result_id": str(row["id"]), **{
            key: str(row[key]) for key in ("assignment_id", "submission_id", "question_id", "answer_attempt_id")}}


def test_compact_reference_cannot_bypass_student_ownership(monkeypatch):
    monkeypatch.setattr(minerva_tools, "_grade_source_row", lambda _session, grade: {"student_id": uuid4()})
    monkeypatch.setattr(minerva_tools, "_student_grade_ids", lambda *_args: [])
    with pytest.raises(ValueError, match="grading_result_id 无效"):
        minerva_tools._hydrate_evidence_refs(None, uuid4(), [{"grading_result_id": str(uuid4())}])
