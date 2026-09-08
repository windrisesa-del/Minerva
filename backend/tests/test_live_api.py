import io
import uuid
import zipfile

from fastapi.testclient import TestClient
from sqlalchemy import text

from app.db import SessionLocal
from app.main import app


def test_health_and_removed_legacy_dashboard() -> None:
    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"
        assert health.json()["database"] == "minerva"

        assert client.get("/").status_code == 404


def test_dashboard_collections() -> None:
    with TestClient(app) as client:
        overview = client.get("/api/overview")
        students = client.get("/api/students")
        answers = client.get("/api/answers/recent")
        assert overview.status_code == 200
        assert overview.json()["students"] >= 0
        assert isinstance(students.json(), list)
        assert isinstance(answers.json(), list)


def test_assignment_collections_and_missing_detail() -> None:
    with TestClient(app) as client:
        assignments = client.get("/api/assignments")
        assert assignments.status_code == 200
        body = assignments.json()
        assert set(body) == {"summary", "assignments"}
        assert body["summary"]["assignment_count"] >= 0
        assert isinstance(body["assignments"], list)

        missing = client.get("/api/assignments/00000000-0000-0000-0000-000000000000")
        assert missing.status_code == 404

        classes = client.get("/api/classes")
        assert classes.status_code == 200
        assert isinstance(classes.json(), list)
        assert "archived_count" in body["summary"]


def test_archive_assignment_keeps_database_row() -> None:
    with TestClient(app) as client:
        rows = client.get("/api/assignments").json()["assignments"]
        if not rows:
            return
        target = rows[0]
        previous = target["status"] if target["status"] != "archived" else "ungraded"
        archived = client.patch(f"/api/assignments/{target['id']}", json={"status": "archived"})
        assert archived.status_code == 200, archived.text
        try:
            assert archived.json()["status"] == "archived"
            listed = client.get("/api/assignments").json()
            match = next(item for item in listed["assignments"] if item["id"] == target["id"])
            assert match["status"] == "archived"
        finally:
            restored = client.patch(f"/api/assignments/{target['id']}", json={"status": previous})
            assert restored.status_code == 200


def test_student_center_sync_writes_to_postgres() -> None:
    student_id = str(uuid.uuid4())
    payload = [{
        "id": student_id,
        "name": "同步测试",
        "studentNumber": "99",
        "className": "24测卓",
        "groupName": "A",
    }]
    with TestClient(app) as client:
        created = client.put("/api/students/sync", json=payload)
        assert created.status_code == 200, created.text
        try:
            students = client.get("/api/students").json()
            match = next(row for row in students if str(row["id"]) == student_id)
            assert match["name"] == "同步测试"
            assert match["student_number"] == "99"
            assert match["class_name"] == "24测卓"
            again = client.put("/api/students/sync", json=[{**payload[0], "groupName": "B"}])
            assert again.status_code == 200
            updated = next(row for row in client.get("/api/students").json() if str(row["id"]) == student_id)
            assert updated["group_name"] == "B"
            assert sum(1 for row in client.get("/api/students").json() if str(row["id"]) == student_id) == 1
        finally:
            with SessionLocal.begin() as session:
                session.execute(text("DELETE FROM audit_logs WHERE entity_id = CAST(:id AS uuid)"), {"id": student_id})
                session.execute(text("DELETE FROM students WHERE id = CAST(:id AS uuid)"), {"id": student_id})


def test_import_rejects_empty_upload() -> None:
    with TestClient(app) as client:
        response = client.post("/api/assignments/import", data={"title": "空导入"})
        assert response.status_code == 400


def test_import_zip_matches_student_number_without_grading() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("提交/1.jpg", b"ungraded-work")
    with TestClient(app) as client:
        classes = client.get("/api/classes").json()
        classroom = next((item for item in classes if item["student_count"] > 0), None)
        if classroom is None:
            return
        response = client.post(
            "/api/assignments/import",
            data={"title": "导入测试_请忽略", "class_id": classroom["id"]},
            files={"archive": ("work.zip", buffer.getvalue(), "application/zip")},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assignment_id = body["assignment_id"]
        try:
            assert body["imported_students"] >= 1
            detail = client.get(f"/api/assignments/{assignment_id}")
            assert detail.status_code == 200
            submitted = [
                student
                for student in detail.json()["students"]
                if student["submission_status"] == "submitted"
            ]
            assert submitted
            assert submitted[0]["score"] is None
        finally:
            with SessionLocal.begin() as session:
                session.execute(text("DELETE FROM assignments WHERE id = CAST(:id AS uuid)"), {"id": assignment_id})
