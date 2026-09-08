from __future__ import annotations

import io
import json
import re
import uuid
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    AnswerAttempt,
    Assignment,
    AssignmentItem,
    AuditLog,
    ClassRoom,
    Enrollment,
    Question,
    Student,
    Submission,
    Teacher,
)


ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf", ".docx", ".txt"}
SPEC_STEMS = {"题目", "题干", "试卷", "assignment", "paper"}
SKIP_NAMES = {".ds_store", "thumbs.db"}
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_TOTAL_BYTES = 80 * 1024 * 1024
MAX_FILES = 200
MIME_BY_SUFFIX = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
    ".json": "application/json",
}
OFFICIAL_QUESTION_TYPES = {"objective", "subjective", "mixed"}
OFFICIAL_QUESTION_SOURCES = {"extracted", "completed"}
OFFICIAL_QUESTION_REQUIRED = (
    "position",
    "question_type",
    "max_score",
    "stem",
    "standard_answer",
    "rubric",
)
UPLOADS_DIR = Path(__file__).resolve().parents[1] / ".data" / "uploads"


GENERIC_FOLDER_NAMES = {
    "提交",
    "作业",
    "学生作业",
    "未批改",
    "submissions",
    "submission",
    "work",
    "files",
    "images",
    "photos",
    "scan",
    "scans",
    "inbox",
}


@dataclass
class IncomingFile:
    original_name: str
    content: bytes
    relative_path: str = ""

    def __post_init__(self) -> None:
        if not self.relative_path:
            self.relative_path = self.original_name.replace("\\", "/")


@dataclass(frozen=True)
class RosterStudent:
    id: str
    name: str
    student_number: str | None


def path_parts(path: str) -> list[str]:
    return [part for part in path.replace("\\", "/").strip("/").split("/") if part]


def first_token(label: str) -> str | None:
    stem = Path(label.replace("\\", "/")).stem.strip()
    if not stem:
        return None
    token = re.split(r"[\s_\-]+", stem, maxsplit=1)[0].strip()
    return token or None


def student_key_from_filename(filename: str) -> str | None:
    return first_token(path_parts(filename)[-1] if path_parts(filename) else filename)


def _is_generic_folder(name: str) -> bool:
    return name.strip().casefold() in {item.casefold() for item in GENERIC_FOLDER_NAMES}


def is_spec_file(path: str) -> bool:
    parts = path_parts(path)
    if not parts:
        return False
    if Path(parts[-1]).stem.strip().lower() not in SPEC_STEMS:
        return False
    return all(_is_generic_folder(part) for part in parts[:-1])


def _looks_like_student_number(token: str, by_number: dict[str, list[RosterStudent]]) -> bool:
    if not token:
        return False
    if token.casefold() in by_number:
        return True
    return token.isdigit()


def match_work_file(
    relative_path: str,
    students: list[RosterStudent],
) -> tuple[RosterStudent | None, str | None]:
    by_number: dict[str, list[RosterStudent]] = defaultdict(list)
    for student in students:
        number = (student.student_number or "").strip()
        if number:
            by_number[number.casefold()].append(student)

    parts = path_parts(relative_path)
    if not parts:
        return None, "无法识别文件路径"
    parents = parts[:-1]
    filename = parts[-1]

    for parent in reversed(parents):
        if _is_generic_folder(parent):
            continue
        token = first_token(parent)
        if not token or not _looks_like_student_number(token, by_number):
            continue
        matches = by_number.get(token.casefold(), [])
        if len(matches) == 1:
            return matches[0], None
        if not matches:
            return None, f"学号 {token} 不在所选班级中"
        return None, f"学号 {token} 对应多名学生"

    token = first_token(filename)
    if token and _looks_like_student_number(token, by_number):
        matches = by_number.get(token.casefold(), [])
        if len(matches) == 1:
            return matches[0], None
        if not matches:
            return None, f"学号 {token} 不在所选班级中"
        return None, f"学号 {token} 对应多名学生"

    haystacks = [*reversed(parents), Path(filename).stem]
    for haystack in haystacks:
        if not haystack or _is_generic_folder(haystack):
            continue
        folded = haystack.casefold()
        hits = [
            student
            for student in students
            if len(student.name.strip()) >= 2 and student.name.strip().casefold() in folded
        ]
        unique_ids = {student.id for student in hits}
        if len(unique_ids) == 1:
            return hits[0], None
        if len(unique_ids) > 1:
            return None, "文件名或文件夹匹配到多名学生"

    return None, "无法匹配。可用学号文件夹（1/第一页.jpg）、学号文件名（1.jpg）或唯一姓名"


def should_skip_path(path: str) -> bool:
    normalized = path.replace("\\", "/").lstrip("./")
    lower = normalized.lower()
    if lower.startswith("__macosx/") or "/__macosx/" in f"/{lower}":
        return True
    name = Path(normalized).name
    if not name or name.startswith(".") or name.lower() in SKIP_NAMES:
        return True
    return Path(name).suffix.lower() not in ALLOWED_EXTENSIONS


def collect_zip_files(archive_bytes: bytes) -> list[IncomingFile]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
    except zipfile.BadZipFile as error:
        raise ValueError("上传的压缩包无法打开，请使用 zip 文件") from error

    try:
        files: list[IncomingFile] = []
        for info in archive.infolist():
            if info.is_dir() or should_skip_path(info.filename):
                continue
            if info.file_size > MAX_FILE_BYTES:
                raise ValueError(f"文件过大：{Path(info.filename).name}")
            content = archive.read(info)
            relative = info.filename.replace("\\", "/").lstrip("./")
            files.append(
                IncomingFile(
                    original_name=Path(relative).name,
                    content=content,
                    relative_path=relative,
                )
            )
        return files
    finally:
        archive.close()


def mime_type_for(filename: str) -> str:
    return MIME_BY_SUFFIX.get(Path(filename).suffix.lower(), "application/octet-stream")


def normalize_official_questions(questions: list[dict]) -> list[dict]:
    if not questions:
        raise ValueError("题目列表不能为空")
    cleaned: list[dict] = []
    seen: set[int] = set()
    for raw in questions:
        if not isinstance(raw, dict):
            raise ValueError("题目数据必须是对象")
        missing = [key for key in OFFICIAL_QUESTION_REQUIRED if raw.get(key) in (None, "")]
        if missing:
            raise ValueError(f"题目缺少字段：{', '.join(missing)}")
        question_type = str(raw["question_type"]).strip()
        if question_type not in OFFICIAL_QUESTION_TYPES:
            raise ValueError(f"不支持的题型：{question_type}")
        try:
            position = int(raw["position"])
            max_score = float(raw["max_score"])
            confidence = float(raw.get("confidence", 1))
        except (TypeError, ValueError) as error:
            raise ValueError("题目序号、分值或置信度格式不正确") from error
        if position < 1:
            raise ValueError("题目序号必须从 1 开始")
        if position in seen:
            raise ValueError(f"题目序号重复：{position}")
        if max_score <= 0:
            raise ValueError("题目分值必须大于 0")
        if not 0 <= confidence <= 1:
            raise ValueError("题目置信度必须在 0 到 1 之间")
        source = str(raw.get("source") or "extracted").strip()
        if source not in OFFICIAL_QUESTION_SOURCES:
            raise ValueError(f"不支持的题目来源：{source}")
        knowledge_points = raw.get("knowledge_points") or []
        if not isinstance(knowledge_points, list):
            raise ValueError("knowledge_points 必须是数组")
        seen.add(position)
        cleaned.append(
            {
                "position": position,
                "question_type": question_type,
                "max_score": max_score,
                "knowledge_points": [str(item).strip() for item in knowledge_points if str(item).strip()],
                "stem": str(raw["stem"]).strip(),
                "standard_answer": str(raw["standard_answer"]).strip(),
                "rubric": str(raw["rubric"]).strip(),
                "source": source,
                "confidence": confidence,
            }
        )
    cleaned.sort(key=lambda item: item["position"])
    for index, item in enumerate(cleaned, start=1):
        if item["position"] != index:
            raise ValueError("题目序号必须从 1 连续编号")
    return cleaned


def import_ungraded_assignment(
    session: Session,
    *,
    title: str,
    class_id: UUID | None,
    files: list[IncomingFile],
    questions: list[dict] | None = None,
) -> dict:
    cleaned_title = title.strip()
    if not cleaned_title:
        raise ValueError("请填写作业标题")
    if len(cleaned_title) > 240:
        raise ValueError("作业标题过长")
    if not files:
        raise ValueError("请上传学生作业文件或 zip 压缩包")
    if len(files) > MAX_FILES:
        raise ValueError(f"一次最多导入 {MAX_FILES} 个文件")
    total = sum(len(item.content) for item in files)
    if total > MAX_TOTAL_BYTES:
        raise ValueError("上传文件总体积过大")
    for item in files:
        if len(item.content) > MAX_FILE_BYTES:
            raise ValueError(f"文件过大：{item.original_name}")
        if Path(item.relative_path).suffix.lower() not in ALLOWED_EXTENSIONS:
            raise ValueError(f"不支持的文件类型：{item.relative_path}")

    teacher = session.scalar(select(Teacher).where(Teacher.name == "本机教师"))
    if teacher is None:
        raise ValueError("未找到本机教师")

    classroom = _resolve_class(session, teacher.id, class_id)
    students = list(
        session.scalars(
            select(Student)
            .join(Enrollment, Enrollment.student_id == Student.id)
            .where(
                Enrollment.class_id == classroom.id,
                Enrollment.left_at.is_(None),
                Student.status == "active",
            )
        ).unique()
    )
    roster = [
        RosterStudent(
            id=str(student.id),
            name=student.name,
            student_number=student.student_number,
        )
        for student in students
    ]
    spec_files = [item for item in files if is_spec_file(item.relative_path)]
    work_files = [item for item in files if item not in spec_files]
    grouped: dict[str, list[IncomingFile]] = defaultdict(list)
    unmatched: list[dict[str, str]] = []
    for item in work_files:
        matched, reason = match_work_file(item.relative_path, roster)
        if matched is not None:
            grouped[matched.id].append(item)
        else:
            unmatched.append({"filename": item.relative_path, "reason": reason or "无法匹配"})

    if not grouped:
        raise ValueError("没有匹配到任何学生。可用学号文件夹、学号文件名或唯一姓名")

    now = datetime.now(timezone.utc)
    assignment = Assignment(
        class_id=classroom.id,
        title=cleaned_title,
        status="draft",
        published_at=now,
        created_by=teacher.id,
    )
    session.add(assignment)
    session.flush()

    spec_attachments = []
    adapter_sources: list[dict] = []
    question_ids: list[UUID] = []
    if questions:
        official = normalize_official_questions(questions)
        spec_attachments.append(
            _store_official_questions_json(
                assignment.id,
                {
                    "title": cleaned_title,
                    "total_score": sum(item["max_score"] for item in official),
                    "questions": official,
                },
            )
        )
        adapter_sources.extend({"role": "assessment_material", **attachment} for attachment in spec_attachments)
        for spec in official:
            question = Question(
                question_type=spec["question_type"],
                stem=spec["stem"],
                standard_answer={"markdown": spec["standard_answer"]},
                source=spec["source"],
                created_by=teacher.id,
            )
            session.add(question)
            session.flush()
            question_ids.append(question.id)
            session.add(
                AssignmentItem(
                    assignment_id=assignment.id,
                    question_id=question.id,
                    position=spec["position"],
                    max_score=spec["max_score"],
                    question_snapshot={**spec, "spec_attachments": spec_attachments},
                )
            )
    else:
        spec_attachments = [_store_file(assignment.id, None, item) for item in spec_files]
        adapter_sources.extend({"role": "assessment_material", **attachment} for attachment in spec_attachments)
        question = Question(
            question_type="subjective",
            stem=cleaned_title,
            standard_answer=None,
            created_by=teacher.id,
        )
        session.add(question)
        session.flush()
        question_ids.append(question.id)
        session.add(
            AssignmentItem(
                assignment_id=assignment.id,
                question_id=question.id,
                position=1,
                max_score=100,
                question_snapshot={
                    "question_type": "subjective",
                    "stem": cleaned_title,
                    "spec_attachments": spec_attachments,
                },
            )
        )

    imported = 0
    for student in students:
        items = grouped.get(str(student.id), [])
        if not items:
            continue
        submission = Submission(
            assignment_id=assignment.id,
            student_id=student.id,
            attempt_number=1,
            status="submitted",
            started_at=now,
            submitted_at=now,
        )
        session.add(submission)
        session.flush()
        attachments = [_store_file(assignment.id, student.id, item) for item in items]
        adapter_sources.extend(
            {"role": "student_submission", "student_id": str(student.id), **attachment}
            for attachment in attachments
        )
        for question_id in question_ids:
            session.add(
                AnswerAttempt(
                    submission_id=submission.id,
                    question_id=question_id,
                    student_id=student.id,
                    attempt_number=1,
                    answer_payload={
                        "text": None,
                        "selected_options": [],
                        "attachments": attachments,
                    },
                    is_correct=None,
                    objective_score=None,
                    answered_at=now,
                    source="import",
                )
            )
        imported += 1

    session.add(
        AuditLog(
            actor_type="teacher",
            actor_id=teacher.id,
            action="import_ungraded_assignment",
            entity_type="assignment",
            entity_id=assignment.id,
            after_data={
                "title": cleaned_title,
                "class_id": str(classroom.id),
                "imported_students": imported,
                "unmatched": unmatched,
            },
        )
    )
    session.commit()
    return {
        "assignment_id": str(assignment.id),
        "title": assignment.title,
        "class_id": str(classroom.id),
        "class_name": classroom.name,
        "imported_students": imported,
        "unmatched": unmatched,
        "adapter_sources": adapter_sources,
    }


def _resolve_class(session: Session, teacher_id: UUID, class_id: UUID | None) -> ClassRoom:
    if class_id is not None:
        classroom = session.get(ClassRoom, class_id)
        if classroom is None or classroom.status != "active":
            raise ValueError("班级不存在")
        return classroom
    classrooms = list(
        session.scalars(
            select(ClassRoom).where(ClassRoom.teacher_id == teacher_id, ClassRoom.status == "active")
        )
    )
    if len(classrooms) == 1:
        return classrooms[0]
    raise ValueError("请选择班级")


def _store_official_questions_json(assignment_id: UUID, payload: dict) -> dict:
    content = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    return _store_file(
        assignment_id,
        None,
        IncomingFile(
            original_name="questions.json",
            content=content,
            relative_path="questions.json",
        ),
    )


def _store_file(assignment_id: UUID, student_id: UUID | None, item: IncomingFile) -> dict:
    folder = UPLOADS_DIR / "assignments" / str(assignment_id)
    if student_id is not None:
        folder = folder / str(student_id)
    else:
        folder = folder / "spec"
    folder.mkdir(parents=True, exist_ok=True)
    suffix = Path(item.original_name).suffix.lower()
    stored_name = f"{uuid.uuid4().hex}{suffix}"
    (folder / stored_name).write_bytes(item.content)
    relative = folder.relative_to(UPLOADS_DIR).as_posix()
    return {
        "storage_key": f"/uploads/{relative}/{stored_name}",
        "original_name": Path(item.original_name).name,
        "mime_type": mime_type_for(item.original_name),
        "size_bytes": len(item.content),
    }
