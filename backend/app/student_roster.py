from __future__ import annotations

import base64
import re
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import AuditLog, ClassRoom, Enrollment, Student, StudentPrivateProfile, Teacher


DATA_URL = re.compile(r"^data:image/(?P<type>[a-zA-Z0-9.+-]+);base64,(?P<data>.+)$", re.DOTALL)
UPLOADS_DIR = Path(__file__).resolve().parents[1] / ".data" / "uploads"


class StudentSyncIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: UUID
    name: str
    student_number: str | None = Field(default=None, alias="studentNumber")
    class_name: str | None = Field(default=None, alias="className")
    group_name: str | None = Field(default=None, alias="groupName")
    guardian_name: str | None = Field(default=None, alias="guardianName")
    guardian_phone: str | None = Field(default=None, alias="guardianPhone")
    email: str | None = None
    notes: str | None = None
    portrait: str | None = None


def _text(value: str | None) -> str | None:
    cleaned = (value or "").strip()
    return cleaned or None


def _save_portrait(value: str | None, student_id: UUID) -> str | None:
    if not value:
        return None
    match = DATA_URL.match(value)
    if not match:
        return value if value.startswith("/uploads/") else None
    extension = "jpg" if match.group("type").lower() == "jpeg" else match.group("type").lower()
    if extension not in {"jpg", "png", "webp", "gif"}:
        return None
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    target = UPLOADS_DIR / f"{student_id}.{extension}"
    target.write_bytes(base64.b64decode(match.group("data")))
    return f"/uploads/{target.name}"


def upsert_students(session: Session, records: list[StudentSyncIn]) -> int:
    if not records:
        raise ValueError("至少需要一名学生")
    teacher = session.scalar(select(Teacher).where(Teacher.name == "本机教师"))
    if teacher is None:
        raise ValueError("未找到本机教师")

    classes: dict[str, ClassRoom] = {}
    now = datetime.now(timezone.utc)
    upserted = 0
    for record in records:
        name = record.name.strip()
        if not name:
            raise ValueError("学生姓名不能为空")
        class_name = _text(record.class_name) or "未分班"
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

        student = session.get(Student, record.id)
        created = student is None
        if student is None:
            student = Student(id=record.id, name=name, status="active")
            session.add(student)
        student.name = name
        student.student_number = _text(record.student_number)
        student.status = "active"
        session.flush()

        profile = session.get(StudentPrivateProfile, record.id)
        portrait_url = _save_portrait(record.portrait, record.id)
        if profile is None:
            profile = StudentPrivateProfile(student_id=record.id)
            session.add(profile)
        profile.guardian_name = _text(record.guardian_name)
        profile.guardian_phone = _text(record.guardian_phone)
        profile.email = _text(record.email)
        profile.notes = _text(record.notes)
        if portrait_url is not None:
            profile.portrait_url = portrait_url

        active = list(
            session.scalars(
                select(Enrollment).where(
                    Enrollment.student_id == record.id,
                    Enrollment.left_at.is_(None),
                )
            )
        )
        current = next((item for item in active if item.class_id == classroom.id), None)
        if current is None:
            prior = session.scalar(
                select(Enrollment).where(
                    Enrollment.student_id == record.id,
                    Enrollment.class_id == classroom.id,
                )
            )
            for item in active:
                item.left_at = now
            if prior is not None:
                prior.left_at = None
                prior.group_name = _text(record.group_name)
            else:
                session.add(
                    Enrollment(
                        student_id=record.id,
                        class_id=classroom.id,
                        group_name=_text(record.group_name),
                        joined_at=now,
                    )
                )
        else:
            current.group_name = _text(record.group_name)
            for item in active:
                if item.id != current.id:
                    item.left_at = now

        session.add(
            AuditLog(
                actor_type="teacher",
                actor_id=teacher.id,
                action="upsert_student" if not created else "create_student",
                entity_type="student",
                entity_id=record.id,
                after_data={"name": name, "class_name": class_name, "source": "student_center"},
            )
        )
        upserted += 1
    session.commit()
    return upserted
