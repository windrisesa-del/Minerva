from __future__ import annotations

import argparse
import base64
import json
import re
import uuid
from datetime import datetime
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal, initialize_database
from app.models import (
    AuditLog,
    ClassRoom,
    Enrollment,
    Student,
    StudentPrivateProfile,
    Teacher,
)


DATA_URL = re.compile(r"^data:image/(?P<type>[a-zA-Z0-9.+-]+);base64,(?P<data>.+)$", re.DOTALL)


def as_uuid(value: str | None) -> uuid.UUID:
    try:
        return uuid.UUID(value or "")
    except ValueError:
        return uuid.uuid4()


def parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def save_portrait(value: str, student_id: uuid.UUID, uploads_dir: Path) -> str | None:
    match = DATA_URL.match(value)
    if not match:
        return None
    extension = "jpg" if match.group("type").lower() == "jpeg" else match.group("type").lower()
    if extension not in {"jpg", "png", "webp", "gif"}:
        return None
    uploads_dir.mkdir(parents=True, exist_ok=True)
    target = uploads_dir / f"{student_id}.{extension}"
    target.write_bytes(base64.b64decode(match.group("data")))
    return f"/uploads/{target.name}"


def migrate(source: Path, uploads_dir: Path) -> tuple[int, int]:
    payload = json.loads(source.read_text(encoding="utf-8"))
    if payload.get("version") != 1 or not isinstance(payload.get("students"), list):
        raise ValueError("Unsupported legacy student-store format")

    initialize_database()
    imported = 0
    skipped = 0
    with SessionLocal.begin() as session:
        teacher = session.scalar(select(Teacher).where(Teacher.name == "本机教师"))
        assert teacher is not None
        classes: dict[str, ClassRoom] = {}

        for record in payload["students"]:
            student_id = as_uuid(record.get("id"))
            if session.get(Student, student_id) is not None:
                skipped += 1
                continue

            class_name = str(record.get("className") or "未分班").strip()
            classroom = classes.get(class_name)
            if classroom is None:
                classroom = session.scalar(
                    select(ClassRoom).where(
                        ClassRoom.teacher_id == teacher.id,
                        ClassRoom.name == class_name,
                    )
                )
                if classroom is None:
                    classroom = ClassRoom(teacher_id=teacher.id, name=class_name, status="active")
                    session.add(classroom)
                    session.flush()
                classes[class_name] = classroom

            created_at = parse_timestamp(record.get("createdAt"))
            updated_at = parse_timestamp(record.get("updatedAt"))
            student = Student(
                id=student_id,
                name=str(record.get("name") or "未命名学生").strip(),
                student_number=str(record.get("studentNumber") or "").strip() or None,
                status="active",
            )
            if created_at is not None:
                student.created_at = created_at
            if updated_at is not None:
                student.updated_at = updated_at
            session.add(student)
            session.flush()

            portrait_url = save_portrait(str(record.get("portrait") or ""), student_id, uploads_dir)
            session.add(
                StudentPrivateProfile(
                    student_id=student_id,
                    guardian_name=str(record.get("guardianName") or "").strip() or None,
                    guardian_phone=str(record.get("guardianPhone") or "").strip() or None,
                    email=str(record.get("email") or "").strip() or None,
                    notes=str(record.get("notes") or "").strip() or None,
                    portrait_url=portrait_url,
                )
            )
            session.add(
                Enrollment(
                    student_id=student_id,
                    class_id=classroom.id,
                    group_name=str(record.get("groupName") or "").strip() or None,
                    joined_at=created_at or datetime.now().astimezone(),
                )
            )
            session.add(
                AuditLog(
                    actor_type="system",
                    action="migrate_legacy_student",
                    entity_type="student",
                    entity_id=student_id,
                    after_data={"source": "students.json", "version": payload["version"]},
                )
            )
            imported += 1
    return imported, skipped


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import Minerva's legacy students.json into PostgreSQL")
    parser.add_argument(
        "--source",
        type=Path,
        default=Path.home() / ".pi" / "minerva" / "students.json",
    )
    parser.add_argument(
        "--uploads-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / ".data" / "uploads",
    )
    args = parser.parse_args()
    if not args.source.exists():
        print(f"No legacy store found at {args.source}; nothing to import.")
    else:
        imported, skipped = migrate(args.source, args.uploads_dir)
        print(f"Imported {imported} student(s); skipped {skipped} existing record(s).")
