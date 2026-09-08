import pytest

from app.minerva_tools import _attach_change_evidence, _observation_diff


def test_profile_paths_and_array_changes():
    before = {"description": {"knowledge_profile": {"a/b~c": {"mastery_level": 2, "mastered_parts": ["旧"]}}}}
    after = {"description": {"knowledge_profile": {"a/b~c": {"mastery_level": 3, "mastered_parts": ["新"]}}}}
    changes = _observation_diff(before, after)
    assert changes == [
        {"path": "/description/knowledge_profile/a~1b~0c/mastered_parts", "operation": "update", "before": ["旧"], "after": ["新"]},
        {"path": "/description/knowledge_profile/a~1b~0c/mastery_level", "operation": "update", "before": 2, "after": 3},
    ]


def test_buffer_removal_preserves_candidate_and_reordering_is_ignored():
    first = {"candidate_id": "a", "claim": "待验证", "evidence": [{"source": {"grading_result_id": "g"}}]}
    second = {"candidate_id": "b", "claim": "另一个"}
    assert _observation_diff([first, second], [second, first], "/evidence_buffer") == []
    assert _observation_diff([first, second], [second], "/evidence_buffer") == [
        {"path": "/evidence_buffer/a", "operation": "remove", "before": first, "after": None}
    ]


@pytest.mark.parametrize("notes", [None, [], [{"path": "/wrong"}],
    [{"path": "/x", "reason": "依据", "evidence_refs": []}],
    [{"path": "/x", "reason": "依据", "evidence_refs": [{"assignment_id": "a"}]}],
    [{"path": "/x", "reason": "", "evidence_refs": [{"grading_result_id": "g"}]}],
    [{"path": "/x"}, {"path": "/x"}]])
def test_missing_or_unmapped_change_evidence_rejected(notes):
    with pytest.raises(ValueError):
        _attach_change_evidence(None, None, [{"path": "/x"}], notes)
