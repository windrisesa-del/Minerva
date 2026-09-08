from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .assignment_import import UPLOADS_DIR
from .models import AnswerAttempt, Assignment, AssignmentItem, AuditLog, Question, Submission


ANALYSIS_FIELDS = {
    "subject",
    "knowledge_domain",
    "question_type",
    "main_concepts",
    "expected_path",
    "dependencies",
    "difficulty",
    "required_abilities",
}


def apply_adapter_assessment(session: Session, assignment_id: UUID, payload: dict[str, Any]) -> dict[str, Any]:
    assignment = session.get(Assignment, assignment_id)
    if assignment is None:
        raise ValueError("作业不存在")
    if assignment.status not in {"draft", "ungraded"}:
        raise ValueError("Adapter 只能更新待预处理或未批改作业")
    if payload.get("schema_version") != "minerva-assessment/0.1" or payload.get("status") != "ungraded":
        raise ValueError("Assessment schema_version 或 status 无效")
    metadata = payload.get("metadata")
    questions = payload.get("questions")
    if not isinstance(metadata, dict) or not isinstance(questions, list) or not questions or not all(isinstance(item, dict) for item in questions):
        raise ValueError("Assessment 必须包含 metadata 和 questions")

    positions = [item.get("position") for item in questions if isinstance(item, dict)]
    if positions != list(range(1, len(questions) + 1)):
        raise ValueError("Assessment 题号必须从 1 连续编号")
    question_ids = [str(item.get("question_id") or "") for item in questions]
    if any(not value for value in question_ids) or len(set(question_ids)) != len(question_ids):
        raise ValueError("Assessment question_id 必须非空且唯一")
    try:
        total_score = float(metadata.get("total_score"))
        item_total = sum(float((item.get("reference_solution") or {}).get("max_score")) for item in questions)
    except (TypeError, ValueError) as error:
        raise ValueError("Assessment 分值必须是数字") from error
    if total_score <= 0 or abs(total_score - item_total) > 0.01:
        raise ValueError("Assessment total_score 必须等于各题 max_score 之和")
    assets = payload.get("assets")
    if not isinstance(assets, dict):
        raise ValueError("Assessment assets 必须是对象")
    asset_ids = set(assets)
    for item in questions:
        analysis = item.get("analysis")
        if not isinstance(analysis, dict):
            raise ValueError("每道题必须包含 analysis")
        unknown_analysis = set(analysis) - ANALYSIS_FIELDS
        if unknown_analysis:
            raise ValueError(f"不支持的题目分析字段：{', '.join(sorted(unknown_analysis))}")
        for block in item.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "image" and block.get("asset_id") not in asset_ids:
                raise ValueError("Assessment 引用了不存在的图片资产")

    student_submissions = payload.get("student_submissions")
    if not isinstance(student_submissions, list):
        raise ValueError("Assessment 必须包含 student_submissions")
    submissions = list(session.scalars(select(Submission).where(Submission.assignment_id == assignment_id)))
    normalized_by_student: dict[str, dict[str, Any]] = {}
    for normalized in student_submissions:
        if not isinstance(normalized, dict) or not normalized.get("student_id"):
            raise ValueError("student_submissions 中的 student_id 无效")
        student_key = str(normalized["student_id"])
        if student_key in normalized_by_student:
            raise ValueError(f"student_submissions 重复学生：{student_key}")
        normalized_by_student[student_key] = normalized
    expected_students = {str(submission.student_id) for submission in submissions}
    if set(normalized_by_student) != expected_students:
        raise ValueError("student_submissions 必须与当前作业的已提交学生完全一致")

    payload["assets"] = _scope_assets(assignment_id, "spec", assets)
    for student_key, normalized in normalized_by_student.items():
        normalized["assets"] = _scope_assets(
            assignment_id,
            f"students/{student_key}",
            normalized.get("assets") if isinstance(normalized.get("assets"), dict) else {},
        )

    submission_ids = [submission.id for submission in submissions]
    if submission_ids:
        session.execute(delete(AnswerAttempt).where(AnswerAttempt.submission_id.in_(submission_ids)))
    session.execute(delete(AssignmentItem).where(AssignmentItem.assignment_id == assignment_id))
    session.flush()

    assessment_path = UPLOADS_DIR / "assignments" / str(assignment_id) / "spec" / "assessment.adapter.json"
    assessment_path.parent.mkdir(parents=True, exist_ok=True)
    assessment_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    assessment_attachment = {
        "storage_key": f"/uploads/assignments/{assignment_id}/spec/{assessment_path.name}",
        "original_name": assessment_path.name,
        "mime_type": "application/json",
        "size_bytes": assessment_path.stat().st_size,
    }

    question_id_map: dict[str, UUID] = {}
    for item in questions:
        reference = item.get("reference_solution") or {}
        analysis = item.get("analysis") or {}
        max_score = float(reference.get("max_score") or 0)
        if max_score <= 0:
            raise ValueError("每道题的 max_score 必须大于 0")
        content = item.get("content") or []
        stem = _content_to_text(content)
        if not stem:
            raise ValueError("每道题必须包含可定位的题目内容")
        question = Question(
            question_type=str(item.get("question_type") or analysis.get("question_type") or "subjective")[:40],
            stem=stem,
            standard_answer={
                "answer": str(reference.get("answer") or ""),
                "reasoning": reference.get("reasoning") or [],
                "scoring_criteria": reference.get("scoring_criteria") or [],
                "partial_credit": reference.get("partial_credit") or [],
            },
            difficulty={"easy": 1, "medium": 2, "hard": 3}.get(str(analysis.get("difficulty"))),
            source="adapter",
            created_by=assignment.created_by,
        )
        session.add(question)
        session.flush()
        question_id_map[str(item["question_id"])] = question.id
        snapshot = {
            **item,
            "max_score": max_score,
            "stem": stem,
            "standard_answer": str(reference.get("answer") or ""),
            "rubric": _rubric_text(reference),
            "knowledge_points": [str(analysis.get("knowledge_domain") or "")],
            "source": "adapter",
            "confidence": 1 if not payload.get("uncertainties") else 0.7,
            "spec_attachments": [assessment_attachment],
        }
        session.add(AssignmentItem(
            assignment_id=assignment_id,
            question_id=question.id,
            position=int(item["position"]),
            max_score=max_score,
            question_snapshot=snapshot,
        ))
    question_keys = set(question_id_map)
    for submission in submissions:
        normalized = normalized_by_student[str(submission.student_id)]
        raw_answers = normalized.get("answers")
        if not isinstance(raw_answers, list):
            raise ValueError("每份 student_submission 必须包含 answers")
        answers_by_question = {
            str(answer.get("question_id")): answer
            for answer in raw_answers
            if isinstance(answer, dict) and answer.get("question_id")
        }
        if set(answers_by_question) != question_keys or len(raw_answers) != len(question_keys):
            raise ValueError("每名学生必须为每道题提供且仅提供一条结构化答案")
        student_assets = normalized.get("assets") if isinstance(normalized.get("assets"), dict) else {}
        for external_question_id, question_id in question_id_map.items():
            answer = answers_by_question[external_question_id]
            content = answer.get("content") if isinstance(answer.get("content"), list) else []
            used_asset_ids = {
                str(block.get("asset_id"))
                for block in content
                if isinstance(block, dict) and block.get("type") == "image" and block.get("asset_id")
            }
            if any(asset_id not in student_assets for asset_id in used_asset_ids):
                raise ValueError("学生答案引用了不存在的图片资产")
            attachments = [
                {
                    "asset_id": asset_id,
                    "storage_key": student_assets[asset_id].get("storage_key") or student_assets[asset_id].get("path"),
                    "original_name": Path(str(student_assets[asset_id].get("path") or "image")).name,
                    "mime_type": student_assets[asset_id].get("mime_type") or "application/octet-stream",
                    "page": student_assets[asset_id].get("page"),
                    "bbox": student_assets[asset_id].get("bbox"),
                    "source_path": student_assets[asset_id].get("source_path"),
                }
                for asset_id in sorted(used_asset_ids)
            ]
            session.add(AnswerAttempt(
                submission_id=submission.id,
                question_id=question_id,
                student_id=submission.student_id,
                attempt_number=1,
                answer_payload={
                    "status": answer.get("status") or "uncertain",
                    "content": content,
                    "text": _content_to_text(content) or None,
                    "selected_options": answer.get("selected_options") if isinstance(answer.get("selected_options"), list) else [],
                    "attachments": attachments,
                    "source_references": answer.get("source_references") if isinstance(answer.get("source_references"), list) else [],
                    "normalized_documents": normalized.get("normalized_documents") or [],
                    "uncertainties": normalized.get("uncertainties") or [],
                },
                is_correct=None,
                objective_score=None,
                source="adapter",
            ))

    assignment.title = str(metadata.get("title") or assignment.title)[:240]
    assignment.status = "ungraded"
    session.add(AuditLog(
        actor_type="agent",
        action="apply_adapter_assessment",
        entity_type="assignment",
        entity_id=assignment_id,
        after_data={
            "schema_version": payload["schema_version"],
            "question_count": len(questions),
            "assessment_path": assessment_attachment["storage_key"],
        },
    ))
    session.commit()
    return {
        "assignment_id": str(assignment_id),
        "status": assignment.status,
        "question_count": len(questions),
        "assessment_path": assessment_attachment["storage_key"],
    }


def _content_to_text(content: list[Any]) -> str:
    parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text" and block.get("text"):
            parts.append(str(block["text"]))
        elif kind == "formula" and block.get("latex"):
            parts.append(f"${block['latex']}$")
        elif kind == "image" and block.get("asset_id"):
            parts.append(f"[asset:{block['asset_id']}]")
        elif kind == "table" and isinstance(block.get("data"), list):
            parts.extend(" | ".join(str(cell) for cell in row) for row in block["data"] if isinstance(row, list))
    return "\n\n".join(part.strip() for part in parts if part.strip())


def _rubric_text(reference: dict[str, Any]) -> str:
    lines = []
    for item in reference.get("scoring_criteria") or []:
        if isinstance(item, dict):
            lines.append(f"{item.get('score', 0)} 分：{item.get('requirement', '')}")
    for item in reference.get("partial_credit") or []:
        if isinstance(item, dict):
            lines.append(f"部分分 {item.get('score', 0)} 分：{item.get('condition', '')}")
    return "\n".join(lines)


def _scope_assets(assignment_id: UUID, relative_group: str, assets: dict[str, Any]) -> dict[str, Any]:
    scoped: dict[str, Any] = {}
    uploads_root = UPLOADS_DIR.resolve()
    target_root = UPLOADS_DIR / "assignments" / str(assignment_id) / relative_group / "adapter-assets"
    target_root.mkdir(parents=True, exist_ok=True)
    for asset_id, raw in assets.items():
        if not isinstance(raw, dict):
            raise ValueError("Assessment asset 必须是对象")
        path = str(raw.get("path") or "")
        if not path.startswith("/uploads/"):
            raise ValueError("Assessment asset 路径无效")
        source = UPLOADS_DIR.joinpath(*path.removeprefix("/uploads/").split("/")).resolve()
        if uploads_root not in source.parents or not source.is_file():
            raise ValueError("Assessment asset 文件不存在或路径越界")
        safe_id = re.sub(r"[^A-Za-z0-9._-]", "_", str(asset_id)) or "asset"
        suffix = source.suffix or ".bin"
        target = target_root / f"{safe_id}{suffix}"
        if source != target.resolve():
            shutil.copy2(source, target)
        storage_key = f"/uploads/{target.relative_to(UPLOADS_DIR).as_posix()}"
        scoped[str(asset_id)] = {**raw, "storage_key": storage_key}
    return scoped
