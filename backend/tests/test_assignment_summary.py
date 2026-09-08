import pytest
from app.assignment_summary import build_statistics


def test_statistics_distinguish_blank_zero_and_unknown_and_deduplicate():
    items = [{"question_id": "q", "position": 1, "max_score": 10}]
    students = [{"student_id": str(i), "student_name": str(i), "grades": [
        {"question_id": "q", "score": score, "answer_payload": {"status": status}},
        {"question_id": "q", "score": 10, "answer_payload": {}}]} for i, (score, status) in enumerate([(0, "blank"), (0, "answered"), (6, "uncertain")])]
    stats = build_statistics(students, items)
    assert stats["questions"][0]["mean_score_rate"] == .2
    assert stats["questions"][0]["blank_count"] == 1
    assert stats["questions"][0]["unknown_answer_status_count"] == 1
    assert stats["questions"][0]["below_half_count"] == 2
    assert stats["overall"]["mean_score"] == 2


def test_missing_grade_is_not_zero():
    with pytest.raises(ValueError, match="批改缺失"):
        build_statistics([{"student_id": "s", "student_name": "s", "grades": []}], [{"question_id": "q", "position": 1, "max_score": 10}])
