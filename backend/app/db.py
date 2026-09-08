from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session, sessionmaker

from .config import database_url
from .models import Base, ClassRoom, Teacher


engine = create_engine(database_url(), pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_session() -> Generator[Session, None, None]:
    with SessionLocal() as session:
        yield session


def initialize_database() -> None:
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("ALTER TABLE assignments DROP CONSTRAINT IF EXISTS ck_assignment_status"))
        connection.execute(text("UPDATE assignments SET status = 'ungraded' WHERE status = 'published'"))
        connection.execute(text("UPDATE assignments SET status = 'graded' WHERE status = 'closed'"))
        connection.execute(
            text(
                "ALTER TABLE assignments ADD CONSTRAINT ck_assignment_status "
                "CHECK (status IN ('draft', 'ungraded', 'graded', 'archived'))"
            )
        )
        connection.execute(
            text("UPDATE assignments SET title = regexp_replace(title, '（未批改）$', '') WHERE title LIKE '%（未批改）'")
        )
        connection.execute(text("ALTER TABLE grading_results ADD COLUMN IF NOT EXISTS voided_at timestamptz"))
        connection.execute(text("ALTER TABLE grading_results ADD COLUMN IF NOT EXISTS void_note text"))
    with SessionLocal.begin() as session:
        teacher = session.scalar(select(Teacher).where(Teacher.name == "本机教师"))
        if teacher is None:
            teacher = Teacher(name="本机教师")
            session.add(teacher)
            session.flush()
        default_class = session.scalar(
            select(ClassRoom).where(
                ClassRoom.teacher_id == teacher.id,
                ClassRoom.name == "未分班",
            )
        )
        if default_class is None:
            session.add(ClassRoom(teacher_id=teacher.id, name="未分班", status="active"))
