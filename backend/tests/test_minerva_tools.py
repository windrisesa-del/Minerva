import io
import zipfile
from copy import deepcopy
from pathlib import Path
from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db import SessionLocal
from app.main import app
from app.models import StudentObservation


def _import_assignment(client: TestClient, title: str) -> dict | None:
    classes = client.get("/api/classes").json()
    classroom = next((item for item in classes if item["student_count"] > 0), None)
    if classroom is None:
        return None
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("提交/1.jpg", b"ungraded-work")
    response = client.post(
        "/api/assignments/import",
        data={"title": title, "class_id": classroom["id"]},
        files={"archive": ("work.zip", buffer.getvalue(), "application/zip")},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_minerva_read_rejects_unknown_resource() -> None:
    with TestClient(app) as client:
        response = client.get("/api/minerva/read", params={"resource": "secrets"})
        assert response.status_code == 400
        assert "不支持读取" in response.json()["detail"]


def test_minerva_write_rejects_closed_kinds() -> None:
    with TestClient(app) as client:
        missing = client.post(
            "/api/minerva/write",
            json={"kind": "student_description", "fields": {"learning_trajectory": {}}},
        )
        assert missing.status_code == 400
        assert "student_id" in missing.json()["detail"]


def test_student_description_uses_three_sections_and_structured_buffer() -> None:
    with TestClient(app) as client:
        students = client.get("/api/students").json()
        if not students:
            return
        student_id = students[0]["id"]
        first = client.post(
            "/api/minerva/write",
            json={
                "kind": "student_description",
                "student_id": student_id,
                "authored_by": "teacher",
                "fields": {
                    "problem_solving_and_learning_profile": {
                        "strong_problem_types": ["能够找出题目关键条件"],
                        "difficult_problem_types": [],
                        "reasoning_characteristics": [],
                        "learning_strategies_and_habits": [],
                        "evidence_refs": [],
                    }
                },
            },
        )
        assert first.status_code == 200, first.text
        second = client.post(
            "/api/minerva/write",
            json={
                "kind": "student_description",
                "student_id": student_id,
                "fields": {
                    "knowledge_profile": {
                        "knowledge_points": {
                            "函数平移": {
                                "knowledge_name": "函数平移",
                                "mastery_level": 3,
                                "mastery_reason": "常规题基本稳定",
                                "mastered_parts": ["能够识别平移方向"],
                                "unmastered_parts": [],
                                "mastery_boundaries": ["含参数问题尚未确认"],
                                "common_errors": [],
                                "evidence_refs": [],
                            }
                        }
                    }
                },
            },
        )
        assert second.status_code == 200, second.text
        description = client.get(
            "/api/minerva/read",
            params={"resource": "student_description", "student_id": student_id},
        )
        record = description.json()["records"][0]["description"]
        assert set(record) == {
            "knowledge_profile",
            "problem_solving_and_learning_profile",
            "learning_trajectory",
        }
        assert record["knowledge_profile"]["knowledge_points"]["函数平移"]["mastery_level"] == 3
        assert record["problem_solving_and_learning_profile"]["strong_problem_types"] == ["能够找出题目关键条件"]
        invalid_star = client.post(
            "/api/minerva/write",
            json={
                "kind": "student_description",
                "student_id": student_id,
                "fields": {"knowledge_profile": {"knowledge_points": {"函数平移": {"mastery_level": 6}}}},
            },
        )
        assert invalid_star.status_code == 400
        assert "1 到 5" in invalid_star.json()["detail"]
        legacy_field = client.post(
            "/api/minerva/write",
            json={"kind": "student_description", "student_id": student_id, "fields": {"teaching_recommendations": []}},
        )
        assert legacy_field.status_code == 400
        buffer = client.post(
            "/api/minerva/write",
            json={
                "kind": "evidence_buffer",
                "student_id": student_id,
                "items": [{
                    "candidate_id": "candidate_function_shift",
                    "target": {
                        "profile_section": "knowledge_profile",
                        "knowledge_id": "函数平移",
                        "attribute": "common_errors",
                    },
                    "claim": "函数平移方向可能仍不稳定",
                    "status": "collecting",
                    "evidence": [{
                        "evidence_id": "evidence_test",
                        "observation": "一次作答中出现方向混淆",
                        "relationship": "supports",
                        "evidence_type": "answer_error",
                        "relevance": 0.9,
                        "reliability": 0.8,
                        "source": {"assignment_id": "assignment_test"},
                    }],
                    "assessment": {
                        "confidence": 0.45,
                        "reason": "目前只有一次证据",
                        "missing_evidence": ["后续同类题表现"],
                    },
                    "recommended_action": "KEEP_BUFFERED",
                }],
            },
        )
        assert buffer.status_code == 200, buffer.text
        items = client.get(
            "/api/minerva/read",
            params={"resource": "evidence_buffer", "student_id": student_id},
        ).json()["records"][0]["items"]
        assert items[0]["claim"] == "函数平移方向可能仍不稳定"
        assert items[0]["summary"]["supporting_count"] == 1
        assert items[0]["recommended_action"] == "KEEP_BUFFERED"


def test_minerva_grading_skips_existing_ai_and_finalize_sets_graded() -> None:
    with TestClient(app) as client:
        imported = _import_assignment(client, "批改工具测试_请忽略")
        if imported is None:
            return
        assignment_id = imported["assignment_id"]
        observation_student_id = None
        observation_snapshot = None
        try:
            submissions = client.get(
                "/api/minerva/read",
                params={"resource": "submissions", "assignment_id": assignment_id},
            )
            assert submissions.status_code == 200, submissions.text
            records = submissions.json()["records"]
            assert records
            first_page = client.get(
                "/api/minerva/read",
                params={"resource": "submissions", "assignment_id": assignment_id, "limit": 1, "offset": 0},
            ).json()
            assert len(first_page["records"]) == 1
            if len(records) > 1:
                assert first_page["has_more"] is True
                assert first_page["next_offset"] == 1
            assert records[0]["has_ai_grading"] is False
            student_id = records[0]["student_id"]
            observation_student_id = student_id
            with SessionLocal() as session:
                previous_observation = session.get(StudentObservation, UUID(student_id))
                if previous_observation is not None:
                    observation_snapshot = {
                        "description": deepcopy(previous_observation.description),
                        "evidence_buffer": deepcopy(previous_observation.evidence_buffer),
                        "teacher_fields": deepcopy(previous_observation.teacher_fields),
                        "last_assignment_id": previous_observation.last_assignment_id,
                    }

            questions = client.get(
                "/api/minerva/read",
                params={"resource": "questions", "assignment_id": assignment_id},
            )
            assert questions.status_code == 200
            question_id = questions.json()["records"][0]["id"]
            submission_id = records[0]["id"]
            one_question = client.get(
                "/api/minerva/read",
                params={
                    "resource": "answer_attempts",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "submission_id": submission_id,
                    "question_id": question_id,
                },
            )
            assert one_question.status_code == 200, one_question.text
            assert len(one_question.json()["records"]) == 1
            assert one_question.json()["records"][0]["question_id"] == question_id
            assert one_question.json()["records"][0]["submission_id"] == submission_id
            unrelated_question = client.get(
                "/api/minerva/read",
                params={
                    "resource": "answer_attempts",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "submission_id": submission_id,
                    "question_id": "00000000-0000-4000-8000-000000000000",
                },
            )
            assert unrelated_question.status_code == 200
            assert unrelated_question.json()["records"] == []

            processing = client.post(
                "/api/minerva/write",
                json={"kind": "processing", "assignment_id": assignment_id, "student_id": student_id, "status": "grading"},
            )
            assert processing.status_code == 200, processing.text
            assert processing.json()["status"] == "grading"
            assert processing.json()["assignment_status"] == "grading"
            progress = client.get(f"/api/assignments/{assignment_id}/processing")
            assert progress.status_code == 200, progress.text
            assert any(item["student_id"] == student_id and item["status"] == "grading" for item in progress.json()["students"])
            released = client.post(
                "/api/minerva/write",
                json={"kind": "processing", "assignment_id": assignment_id, "student_id": student_id, "status": "submitted"},
            )
            assert released.status_code == 200, released.text
            invalid_score = client.post(
                "/api/minerva/write",
                json={
                    "kind": "grading",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "items": [{"question_id": question_id, "score": 101, "feedback": "越界"}],
                },
            )
            assert invalid_score.status_code == 400
            assert "score 必须在 0 到 100 之间" in invalid_score.json()["detail"]

            first = client.post(
                "/api/minerva/write",
                json={
                    "kind": "grading",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "overall_feedback": "卷面清楚。",
                    "items": [
                        {
                            "question_id": question_id,
                            "score": 88,
                            "feedback": "过程完整。",
                            "is_correct": True,
                            "max_score": 100,
                            "confidence": 0.9,
                            "error_type": "none",
                            "rubric_items": [{"requirement": "过程完整", "score": 88, "max_score": 100, "hit": True}],
                        }
                    ],
                },
            )
            assert first.status_code == 200, first.text
            assert first.json()["saved"] == 1
            assert first.json()["finalized"] is False

            graded_students = client.get(
                "/api/minerva/read",
                params={"resource": "graded_students", "assignment_id": assignment_id, "limit": 1, "offset": 0},
            )
            assert graded_students.status_code == 200, graded_students.text
            graded_page = graded_students.json()
            assert graded_page["records"][0]["student_id"] == student_id
            assert graded_page["records"][0]["submission_id"] == submission_id
            assert graded_page["records"][0]["grading_result_count"] == 1
            assert graded_page["has_more"] is False

            again = client.post(
                "/api/minerva/write",
                json={
                    "kind": "grading",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "items": [{"question_id": question_id, "score": 10, "feedback": "不应覆盖"}],
                },
            )
            assert again.status_code == 200, again.text
            assert again.json()["saved"] == 0
            assert again.json()["skipped"] == 1

            results = client.get(
                "/api/minerva/read",
                params={"resource": "grading_results", "assignment_id": assignment_id, "student_id": student_id},
            )
            assert results.status_code == 200
            result_page = results.json()
            scores = [row["score"] for row in result_page["records"] if row["grader_type"] == "ai"]
            assert scores == [88]
            assert result_page["has_more"] is False
            evidence = result_page["records"][0]
            assert evidence["max_score"] == 100
            assert evidence["question_type"]
            assert evidence["question_stem"]
            assert "rubric_result" in evidence
            assert evidence["rubric_result"]["error_type"] == "none"
            assert evidence["rubric_result"]["rubric_items"][0]["hit"] is True
            assert "question_analysis" in evidence
            assert "knowledge_points" in evidence
            assert "answer_payload" in evidence

            from app.minerva_tools import _observation_diff
            before_profile = client.get("/api/minerva/read", params={"resource": "student_description", "student_id": student_id}).json()["records"][0]["description"]
            before_buffer = client.get("/api/minerva/read", params={"resource": "evidence_buffer", "student_id": student_id}).json()["records"][0]["items"]
            target_section = {
                "strong_problem_types": ["能够完成当前常规题"], "difficult_problem_types": [],
                "reasoning_characteristics": [], "learning_strategies_and_habits": [],
                "evidence_refs": [{"assignment_id": assignment_id, "submission_id": submission_id,
                                   "question_id": question_id, "answer_attempt_id": evidence["answer_attempt_id"],
                                   "grading_result_id": evidence["id"]}],
            }
            before_state = {"description": before_profile, "evidence_buffer": before_buffer}
            after_state = {"description": {**before_profile, "problem_solving_and_learning_profile": target_section}, "evidence_buffer": []}
            change_notes = [{"path": item["path"], "reason": "本次常规题批改支持该更新", "evidence_refs": [{"grading_result_id": evidence["id"]}]}
                            for item in _observation_diff(before_state, after_state)]
            observed = client.post(
                "/api/minerva/write",
                json={
                    "kind": "student_observation",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "profile_fields": {
                        "problem_solving_and_learning_profile": {
                            "strong_problem_types": ["能够完成当前常规题"],
                            "difficult_problem_types": [],
                            "reasoning_characteristics": [],
                            "learning_strategies_and_habits": [],
                            "evidence_refs": [{
                                "assignment_id": assignment_id,
                                "submission_id": submission_id,
                                "question_id": question_id,
                                "answer_attempt_id": evidence["answer_attempt_id"],
                                "grading_result_id": evidence["id"],
                            }],
                        }
                    },
                    "buffer_items": [],
                    "change_notes": change_notes,
                },
            )
            assert observed.status_code == 200, observed.text
            assert observed.json()["kind"] == "student_observation"
            assert observed.json()["description"]["problem_solving_and_learning_profile"]["strong_problem_types"] == ["能够完成当前常规题"]
            history = client.get("/api/minerva/read", params={"resource": "observation_history", "student_id": student_id, "assignment_id": assignment_id}).json()
            assert history["records"][0]["before"]["description"] == before_state["description"]
            assert history["records"][0]["before"]["evidence_buffer"] == before_state["evidence_buffer"]
            assert history["records"][0]["after"]["description"] == after_state["description"]
            assert history["records"][0]["after"]["changes"] == observed.json()["changes"]

            operation_path = "/description/learning_trajectory/developing_abilities"
            operation_value = ["开始在多步题中写出中间依据"]
            operation_before = deepcopy(
                after_state["description"]["learning_trajectory"]["developing_abilities"]
            )
            operation_version = client.get(
                "/api/minerva/read",
                params={"resource": "student_description", "student_id": student_id},
            ).json()["records"][0]["updated_at"]
            operated = client.post(
                "/api/minerva/write",
                json={
                    "kind": "student_observation",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "expected_observation_updated_at": operation_version,
                    "operations": [{
                        "op": "set",
                        "path": operation_path,
                        "value": operation_value,
                        "reason": "本次常规题过程支持该观察",
                        "evidence_refs": [{"grading_result_id": evidence["id"]}],
                    }],
                },
            )
            assert operated.status_code == 200, operated.text
            assert operated.json()["updated_fields"] == ["learning_trajectory"]
            assert operated.json()["changes"] == [{
                "path": operation_path,
                "operation": "update",
                "before": operation_before,
                "after": operation_value,
                "reason": "本次常规题过程支持该观察",
                "evidence_refs": [{
                    "grading_result_id": evidence["id"],
                    "assignment_id": assignment_id,
                    "submission_id": submission_id,
                    "question_id": question_id,
                    "answer_attempt_id": evidence["answer_attempt_id"],
                }],
            }]
            after_state["description"] = deepcopy(operated.json()["description"])

            stale = client.post(
                "/api/minerva/write",
                json={
                    "kind": "student_observation",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "expected_observation_updated_at": operation_version,
                    "operations": [],
                    "evaluation_complete": True,
                    "report_significance": {"include_in_teacher_report": False, "level": "none"},
                },
            )
            assert stale.status_code == 400
            assert "STUDENT_OBSERVATION_STALE" in stale.json()["detail"]

            mixed_contract = client.post(
                "/api/minerva/write",
                json={
                    "kind": "student_observation",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "operations": [],
                    "change_notes": [],
                    "evaluation_complete": True,
                    "report_significance": {"include_in_teacher_report": False, "level": "none"},
                },
            )
            assert mixed_contract.status_code == 400
            assert "不能与" in mixed_contract.json()["detail"]
            rejected = client.post("/api/minerva/write", json={"kind": "student_observation", "assignment_id": assignment_id,
                "student_id": student_id, "profile_fields": {"learning_trajectory": {"recent_progress": ["不带证据的更改"]}}})
            assert rejected.status_code == 400
            unchanged = client.get("/api/minerva/read", params={"resource": "student_description", "student_id": student_id}).json()["records"][0]["description"]
            assert unchanged == after_state["description"]

            forged_evidence = client.post(
                "/api/minerva/write",
                json={
                    "kind": "student_observation",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "profile_fields": {
                        "learning_trajectory": {
                            "recent_progress": ["伪造证据不应写入"],
                            "recent_regressions": [],
                            "emerging_problems": [],
                            "developing_abilities": [],
                            "evidence_refs": [{"grading_result_id": "00000000-0000-4000-8000-000000000000"}],
                        }
                    },
                },
            )
            assert forged_evidence.status_code == 400
            assert "grading_result_id 无效" in forged_evidence.json()["detail"]
            assert "当前学生可用的 grading_result_id" in forged_evidence.json()["detail"]

            invented_knowledge = client.post(
                "/api/minerva/write",
                json={
                    "kind": "student_observation",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "profile_fields": {
                        "knowledge_profile": {
                            "knowledge_points": {
                                "不存在的知识点": {
                                    "knowledge_name": "不存在的知识点",
                                    "mastery_level": 3,
                                    "evidence_refs": [{"grading_result_id": evidence["id"]}],
                                }
                            }
                        }
                    },
                },
            )
            assert invented_knowledge.status_code == 400
            assert "knowledge_id 不在当前题目或既有学生描述中" in invented_knowledge.json()["detail"]

            ai_only = client.get(
                "/api/minerva/read",
                params={
                    "resource": "grading_results",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                    "grader_type": "ai",
                    "limit": 1,
                    "offset": 0,
                },
            )
            assert ai_only.status_code == 200, ai_only.text
            assert all(row["grader_type"] == "ai" for row in ai_only.json()["records"])

            remaining = [row for row in records if row["student_id"] != student_id]
            for row in remaining:
                saved = client.post(
                    "/api/minerva/write",
                    json={
                        "kind": "grading",
                        "assignment_id": assignment_id,
                        "student_id": row["student_id"],
                        "items": [{"question_id": question_id, "score": 70, "feedback": "已批。"}],
                    },
                )
                assert saved.status_code == 200, saved.text

            all_graded_page = client.get(
                "/api/minerva/read",
                params={"resource": "graded_students", "assignment_id": assignment_id, "limit": 1, "offset": 0},
            ).json()
            assert len(all_graded_page["records"]) == 1
            assert all_graded_page["has_more"] is (len(records) > 1)
            assert all_graded_page["next_offset"] == (1 if len(records) > 1 else None)

            scoped_graded_student = client.get(
                "/api/minerva/read",
                params={
                    "resource": "graded_students",
                    "assignment_id": assignment_id,
                    "student_id": student_id,
                },
            ).json()["records"]
            assert len(scoped_graded_student) == 1
            assert scoped_graded_student[0]["student_id"] == student_id

            finalized = client.post(
                "/api/minerva/write",
                json={"kind": "grading", "assignment_id": assignment_id, "finalize": True},
            )
            assert finalized.status_code == 200, finalized.text
            assert finalized.json()["status"] == "graded"
            detail = client.get(f"/api/assignments/{assignment_id}")
            assert detail.status_code == 200
            assert detail.json()["assignment"]["status"] == "graded"

            assert client.post(f"/api/assignments/{assignment_id}/summary/prepare", json={}).status_code == 409
            missing_significance = client.post("/api/minerva/write", json={"kind": "student_observation", "assignment_id": assignment_id,
                "student_id": student_id, "evaluation_complete": True, "change_notes": []})
            assert missing_significance.status_code == 400
            assert "report_significance" in missing_significance.json()["detail"]
            completed = client.post("/api/minerva/write", json={"kind": "student_observation", "assignment_id": assignment_id,
                "student_id": student_id, "evaluation_complete": True, "change_notes": [],
                "report_significance": {"include_in_teacher_report": False, "level": "none"}})
            assert completed.status_code == 200, completed.text
            receipt = client.get(f"/api/assignments/{assignment_id}/evaluation/{student_id}").json()
            assert receipt["completed"] is True
            from app.assignment_summary import complete_evaluation
            from app.minerva_tools import _canonical_description
            with SessionLocal.begin() as session:
                for student in remaining:
                    current = session.get(StudentObservation, UUID(student["student_id"]))
                    complete_evaluation(session, UUID(assignment_id), UUID(student["student_id"]), _canonical_description(current.description if current else None))
            prepared = client.post(f"/api/assignments/{assignment_id}/summary/prepare", json={})
            assert prepared.status_code == 200, prepared.text
            report_id = prepared.json()["id"]
            assert len(prepared.json()["statistics"]["students"]) == len(records)
            assert prepared.json()["report_context"]["assignment"]["title"] == "批改工具测试_请忽略"
            assert len(prepared.json()["report_context"]["questions"]) == len(questions.json()["records"])
            assert client.post(f"/api/assignments/{assignment_id}/summary/prepare", json={}).json()["id"] == report_id
            page = client.get(f"/api/summary/{report_id}/input", params={"resource": "students", "limit": 1}).json()
            assert "grades" not in page["records"][0]
            assert "evidence_buffer" in page["records"][0]
            assert page["records"][0]["report_significance"]["include_in_teacher_report"] is False
            assert page["has_more"] == (len(records) > 1)
            invalid = {"assignment_overview": {"text": "测试作业。", "question_ids": [question_id]},
                       "overall": {"text": "测试", "stat_refs": ["invented"]},
                       "well_completed_questions": [], "problem_questions": [], "student_highlights": []}
            assert client.post(f"/api/summary/{report_id}", json={"narrative": invalid}).status_code == 400
            valid = {"assignment_overview": {"text": "本次作业包含当前题目。", "question_ids": [question_id]},
                     "overall": {"text": "本次作业已完成批改。", "stat_refs": ["overall.submitted_count"]},
                     "well_completed_questions": [], "problem_questions": [], "student_highlights": []}
            saved_report = client.post(f"/api/summary/{report_id}", json={"narrative": valid})
            assert saved_report.status_code == 200, saved_report.text
            assert saved_report.json()["status"] == "completed"
            assert client.post(f"/api/summary/{report_id}", json={"narrative": valid}).status_code == 400

            with SessionLocal.begin() as session:
                concurrent_observation = session.get(StudentObservation, UUID(student_id))
                assert concurrent_observation is not None
                concurrent_observation.description = {
                    **deepcopy(concurrent_observation.description),
                    "learning_trajectory": {
                        **deepcopy(concurrent_observation.description["learning_trajectory"]),
                        "recent_progress": ["Evaluator 之后的新修改"],
                    },
                }
            conflict = client.delete(f"/api/assignments/{assignment_id}")
            assert conflict.status_code == 409
            assert "已停止清理以免覆盖新数据" in conflict.json()["detail"]
            assert client.get(f"/api/assignments/{assignment_id}").status_code == 200
            with SessionLocal.begin() as session:
                concurrent_observation = session.get(StudentObservation, UUID(student_id))
                assert concurrent_observation is not None
                concurrent_observation.description = deepcopy(after_state["description"])

            discarded = client.delete(f"/api/assignments/{assignment_id}")
            assert discarded.status_code == 200, discarded.text
            assert discarded.json()["reverted_observation_writes"] >= 1
            assert client.get(f"/api/assignments/{assignment_id}").status_code == 404
            with SessionLocal() as session:
                restored_observation = session.get(StudentObservation, UUID(student_id))
                if observation_snapshot is None:
                    assert restored_observation is None
                else:
                    assert restored_observation is not None
                    assert restored_observation.description == observation_snapshot["description"]
                    assert restored_observation.evidence_buffer == observation_snapshot["evidence_buffer"]
                    assert restored_observation.teacher_fields == observation_snapshot["teacher_fields"]
                    assert restored_observation.last_assignment_id == observation_snapshot["last_assignment_id"]

        finally:
            with SessionLocal.begin() as session:
                session.execute(text("DELETE FROM assignments WHERE id = CAST(:id AS uuid)"), {"id": assignment_id})
                if observation_student_id is not None:
                    current_observation = session.get(StudentObservation, UUID(observation_student_id))
                    if observation_snapshot is None:
                        if current_observation is not None:
                            session.delete(current_observation)
                    else:
                        assert current_observation is not None
                        current_observation.description = observation_snapshot["description"]
                        current_observation.evidence_buffer = observation_snapshot["evidence_buffer"]
                        current_observation.teacher_fields = observation_snapshot["teacher_fields"]
                        current_observation.last_assignment_id = observation_snapshot["last_assignment_id"]


def test_finalize_without_ai_grades_is_rejected() -> None:
    with TestClient(app) as client:
        imported = _import_assignment(client, "未完成批改测试_请忽略")
        if imported is None:
            return
        assignment_id = imported["assignment_id"]
        try:
            blocked = client.post(
                "/api/minerva/write",
                json={"kind": "grading", "assignment_id": assignment_id, "finalize": True},
            )
            assert blocked.status_code == 400
            assert "不能 finalize" in blocked.json()["detail"]
            detail = client.get(f"/api/assignments/{assignment_id}")
            assert detail.json()["assignment"]["status"] == "draft"
        finally:
            with SessionLocal.begin() as session:
                session.execute(text("DELETE FROM assignments WHERE id = CAST(:id AS uuid)"), {"id": assignment_id})


def test_discard_assignment_removes_database_record_and_uploaded_files() -> None:
    with TestClient(app) as client:
        imported = _import_assignment(client, "失败后清理测试_请忽略")
        if imported is None:
            return
        assignment_id = imported["assignment_id"]
        upload_directory = Path(__file__).resolve().parents[1] / ".data" / "uploads" / "assignments" / assignment_id
        assert upload_directory.exists()

        discarded = client.delete(f"/api/assignments/{assignment_id}")
        assert discarded.status_code == 200, discarded.text
        assert discarded.json()["discarded"] is True
        assert client.get(f"/api/assignments/{assignment_id}").status_code == 404
        assert not upload_directory.exists()
