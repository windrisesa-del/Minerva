from __future__ import annotations

import json
import uuid

from app.db import SessionLocal
from app.models import Student, StudentObservation
from app import wiki_graph


def test_graph_combines_minerva_mastery_with_wiki_pages(monkeypatch) -> None:
    student_id = uuid.uuid4()
    with SessionLocal.begin() as session:
        session.add(Student(id=student_id, name="图谱测试学生"))
        session.add(
            StudentObservation(
                student_id=student_id,
                description={
                    "knowledge_profile": {
                        "knowledge_points": {
                            "linear-equation": {
                                "knowledge_name": "一元一次方程",
                                "subject": "数学",
                                "knowledge_domain": "方程",
                                "mastery_level": 4,
                                "mastery_reason": "能够稳定完成移项",
                                "mastered_parts": ["移项"],
                                "unmastered_parts": [],
                                "mastery_boundaries": ["含参数时不稳定"],
                                "common_errors": [],
                                "evidence_refs": [],
                            },
                            "fraction": {
                                "knowledge_name": "分式",
                                "subject": "数学",
                                "knowledge_domain": "有理式",
                                "mastery_level": 2,
                                "mastery_reason": "通分仍有错误",
                                "mastered_parts": [],
                                "unmastered_parts": ["通分"],
                                "mastery_boundaries": [],
                                "common_errors": ["漏乘分母"],
                                "evidence_refs": [],
                            },
                        }
                    }
                },
                evidence_buffer=[],
                teacher_fields=[],
            )
        )

    monkeypatch.setattr(
        wiki_graph,
        "_fetch_wiki_snapshot",
        lambda: {
            "status": "connected",
            "url": "http://127.0.0.1:3002",
            "message": "connected",
            "pages": [
                {
                    "id": 11,
                    "path": "math/linear-equation",
                    "locale": "zh",
                    "title": "一元一次方程",
                    "description": "方程基础",
                    "isPublished": True,
                    "tags": ["minerva:linear-equation"],
                },
                {
                    "id": 12,
                    "path": "math/fraction",
                    "locale": "zh",
                    "title": "分式",
                    "description": "分式基础",
                    "isPublished": True,
                    "tags": [],
                },
            ],
            "links": [
                {"id": 11, "path": "math/linear-equation", "title": "一元一次方程", "links": ["math/fraction"]},
                {"id": 12, "path": "math/fraction", "title": "分式", "links": []},
            ],
        },
    )
    try:
        with SessionLocal() as session:
            result = wiki_graph.build_student_knowledge_graph(session, student_id)
        assert result["wiki"] == {
            "status": "connected",
            "url": "http://127.0.0.1:3002",
            "page_count": 2,
            "matched_count": 2,
            "message": "connected",
        }
        by_type = {}
        for node in result["nodes"]:
            by_type.setdefault(node["type"], []).append(node)
        assert len(by_type["student"]) == 1
        assert {node["label"] for node in by_type["subject"]} == {"数学"}
        assert {node["label"] for node in by_type["domain"]} == {"方程", "有理式"}
        knowledge = {node["knowledge_id"]: node for node in by_type["knowledge"]}
        assert knowledge["linear-equation"]["mastery_level"] == 4
        assert knowledge["linear-equation"]["subject"] == "数学"
        assert knowledge["linear-equation"]["knowledge_domain"] == "方程"
        assert knowledge["linear-equation"]["wiki_page"]["url"] == "http://127.0.0.1:3002/zh/math/linear-equation"
        assert knowledge["fraction"]["common_errors"] == ["漏乘分母"]
        assert sum(edge["type"] == "contains" for edge in result["edges"]) == 5
        assert sum(edge["type"] == "wiki" for edge in result["edges"]) == 1
        assert sum(edge["type"] == "mastery" for edge in result["edges"]) == 0
    finally:
        with SessionLocal.begin() as session:
            session.query(Student).filter(Student.id == student_id).delete()


def test_wiki_request_contains_only_static_page_query(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return None

        def read(self):
            return json.dumps({"data": {"pages": {"list": [], "links": []}}}).encode()

    def fake_urlopen(request, timeout):
        captured["body"] = json.loads(request.data.decode())
        captured["timeout"] = timeout
        captured["authorization"] = request.headers.get("Authorization")
        return Response()

    monkeypatch.setenv("WIKIJS_API_TOKEN", "token-demo")
    monkeypatch.setattr(wiki_graph, "urlopen", fake_urlopen)
    snapshot = wiki_graph._fetch_wiki_snapshot()
    assert snapshot["status"] == "connected"
    assert captured["timeout"] == 3
    assert captured["authorization"] == "Bearer token-demo"
    assert "student" not in json.dumps(captured["body"]).casefold()
