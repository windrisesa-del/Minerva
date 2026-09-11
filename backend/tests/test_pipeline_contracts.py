import pytest

from app.assessment_adapter import knowledge_ids_from_analysis
from app.minerva_tools import (
    _clean_evidence_buffer,
    _clean_evidence_refs,
    _clean_report_significance,
    _clean_rubric_result,
    _snapshot_knowledge_ids,
)


def test_knowledge_ids_prefer_main_concepts_over_domain():
    assert knowledge_ids_from_analysis({
        "knowledge_domain": "函数",
        "main_concepts": ["函数定义域", "分母不为零", "函数定义域"],
    }) == ["函数定义域", "分母不为零"]
    assert knowledge_ids_from_analysis({"knowledge_domain": "函数", "main_concepts": []}) == ["函数"]
    assert knowledge_ids_from_analysis({"knowledge_domain": "", "main_concepts": []}) == []


def test_snapshot_knowledge_ids_include_concepts_and_stored_points():
    ids = _snapshot_knowledge_ids({
        "knowledge_points": ["函数"],
        "analysis": {"knowledge_domain": "函数", "main_concepts": ["函数定义域"]},
    })
    assert ids == {"函数", "函数定义域"}


def test_structured_rubric_result_persists_error_and_item_scores():
    result = _clean_rubric_result(
        {
            "is_correct": False,
            "error_type": "conceptual_error",
            "knowledge_results": [{"knowledge_id": "函数定义域", "result": "incorrect", "note": "漏分母限制"}],
            "rubric_items": [
                {"requirement": "写出 x≥1", "score": 4, "max_score": 4, "hit": True},
                {"requirement": "写出 x≠2", "score": 0, "max_score": 4, "hit": False},
            ],
        },
        max_score=10,
        snapshot={"knowledge_points": ["函数定义域"], "analysis": {"main_concepts": ["函数定义域"]}},
        overall_feedback="卷面清楚。",
    )
    assert result["error_type"] == "conceptual_error"
    assert result["knowledge_results"][0]["result"] == "incorrect"
    assert result["rubric_items"][1]["hit"] is False
    assert result["overall_feedback"] == "卷面清楚。"


def test_structured_rubric_rejects_unknown_error_and_knowledge():
    with pytest.raises(ValueError, match="error_type"):
        _clean_rubric_result({"error_type": "lazy"}, max_score=10, snapshot={}, overall_feedback=None)
    with pytest.raises(ValueError, match="不在当前题目知识点中"):
        _clean_rubric_result(
            {"knowledge_results": [{"knowledge_id": "不存在", "result": "incorrect"}]},
            max_score=10,
            snapshot={"knowledge_points": ["函数定义域"]},
            overall_feedback=None,
        )


def test_evidence_refs_accept_grade_id_string_and_object():
    assert _clean_evidence_refs(["abc"], "refs") == [{"grading_result_id": "abc"}]
    assert _clean_evidence_refs([{"grading_result_id": "abc"}], "refs") == [{"grading_result_id": "abc"}]
    nested = _clean_evidence_refs([{"source": {"grading_result_id": "abc", "question_id": "q"}}], "refs")
    assert nested == [{"grading_result_id": "abc", "question_id": "q"}]


def test_buffer_evidence_accepts_top_level_grade_id_without_source():
    items = _clean_evidence_buffer([{
        "candidate_id": "c1",
        "target": {"profile_section": "knowledge_profile", "knowledge_id": "函数", "attribute": "common_errors"},
        "claim": "待观察",
        "status": "collecting",
        "evidence": [{
            "evidence_id": "e1",
            "observation": "本题有记录",
            "relationship": "supports",
            "grading_result_id": "grade-1",
        }],
        "assessment": {"confidence": 0.4, "reason": "一次证据", "missing_evidence": []},
        "recommended_action": "KEEP_BUFFERED",
    }])
    assert items[0]["evidence"][0]["source"] == {"grading_result_id": "grade-1"}


def test_report_significance_requires_message_and_type_when_included():
    skipped = _clean_report_significance(None, required=True)
    assert skipped["include_in_teacher_report"] is False
    included = _clean_report_significance({
        "include_in_teacher_report": True,
        "level": "medium",
        "type": "observation",
        "message": "定义域限制条件仍需观察。",
        "buffer_candidate_ids": ["c1"],
    }, required=True)
    assert included["type"] == "observation"
    with pytest.raises(ValueError, match="纳入报告时"):
        _clean_report_significance({
            "include_in_teacher_report": True,
            "level": "medium",
            "message": "缺少类型。",
        }, required=True)
