import pytest
from app.assignment_summary import assert_student_highlight_coverage, build_report_context, build_statistics, receipt_history


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


def test_receipt_history_keeps_buffer_changes():
    history = receipt_history([{
        "id": "a1",
        "created_at": "2026-09-10",
        "before": {"description": {"old": True}, "evidence_buffer": [{"candidate_id": "c1"}]},
        "after": {
            "description": {"old": False},
            "evidence_buffer": [{"candidate_id": "c1"}, {"candidate_id": "c2"}],
            "changes": [
                {"path": "/description/learning_trajectory/recent_progress"},
                {"path": "/evidence_buffer/c2"},
            ],
        },
    }])
    assert history[0]["before"]["evidence_buffer"] == [{"candidate_id": "c1"}]
    assert [item["path"] for item in history[0]["after"]["changes"]] == [
        "/description/learning_trajectory/recent_progress",
        "/evidence_buffer/c2",
    ]


def test_report_must_follow_evaluator_significance():
    students = [
        {"student_id": "keep", "report_significance": {"include_in_teacher_report": True}},
        {"student_id": "skip", "report_significance": {"include_in_teacher_report": False}},
        {"student_id": "legacy"},
    ]
    assert_student_highlight_coverage(students, [{"student_id": "keep"}])
    assert_student_highlight_coverage(students, [
        {"student_id": "keep"},
        {"student_id": "skip", "type": "current_submission_anomaly"},
    ])
    with pytest.raises(ValueError, match="必须报告"):
        assert_student_highlight_coverage(students, [])
    with pytest.raises(ValueError, match="只能报告本次作业异常"):
        assert_student_highlight_coverage(students, [{"student_id": "keep"}, {"student_id": "skip", "type": "progress"}])


def test_report_context_combines_content_grading_and_updated_profiles():
    items = [{
        "question_id": "q1", "position": 1, "max_score": 10,
        "question_snapshot": {
            "question_type": "subjective", "stem": "求函数导数",
            "analysis": {
                "subject": "数学", "knowledge_domain": "函数",
                "main_concepts": ["导数"], "expected_path": ["使用求导法则"],
                "dependencies": ["函数定义"], "difficulty": "medium",
                "required_abilities": ["符号运算"],
            },
        },
    }]
    grade = {
        "id": "g1", "question_id": "q1", "score": 6,
        "answer_payload": {"status": "answered", "text": "..."},
        "feedback": "链式法则缺少外层系数", "rubric_result": {"error_type": "calculation"},
        "confidence": 0.9,
    }
    students = [{
        "student_id": "s1", "student_name": "学生甲", "profile_snapshot_id": "p1",
        "description": {"problem_solving": {"reasoning_features": ["步骤清晰"]}},
        "evidence_buffer": [{"candidate_id": "c1"}], "changes": [{"id": "a1"}],
        "report_significance": {"include_in_teacher_report": True}, "grades": [grade],
    }]
    statistics = build_statistics(students, items)
    context = build_report_context("函数作业", students, items, statistics)
    assert context["assignment"]["knowledge_distribution"][0]["knowledge_domain"] == "函数"
    assert context["assignment"]["ability_distribution"][0]["ability"] == "符号运算"
    assert context["questions"][0]["student_results"][0]["grading_result_id"] == "g1"
    assert context["questions"][0]["student_results"][0]["grading_basis"] == "链式法则缺少外层系数"
    assert context["students"][0]["description"]["problem_solving"]["reasoning_features"] == ["步骤清晰"]
    assert context["students"][0]["evidence_buffer"][0]["candidate_id"] == "c1"
