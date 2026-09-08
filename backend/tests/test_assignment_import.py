import io
import zipfile

import pytest

from app.assignment_import import (
    RosterStudent,
    collect_zip_files,
    is_spec_file,
    match_work_file,
    normalize_official_questions,
    student_key_from_filename,
)


ROSTER = [
    RosterStudent(id="a", name="蕾丝员", student_number="1"),
    RosterStudent(id="b", name="雷思源", student_number="2"),
]


def test_student_key_from_filename() -> None:
    assert student_key_from_filename("1.jpg") == "1"
    assert student_key_from_filename("1_张三.pdf") == "1"
    assert student_key_from_filename("12-作业.png") == "12"
    assert student_key_from_filename("提交/1.webp") == "1"
    assert is_spec_file("题目.pdf")
    assert is_spec_file("作业/题目.pdf")
    assert not is_spec_file("1.jpg")
    assert not is_spec_file("1/题目.pdf")


def test_collect_zip_keeps_relative_paths() -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("提交/1.jpg", b"fake-image")
        archive.writestr("题目.pdf", b"fake-pdf")
        archive.writestr("__MACOSX/._1.jpg", b"skip")
        archive.writestr(".DS_Store", b"skip")
    files = collect_zip_files(buffer.getvalue())
    names = sorted(item.original_name for item in files)
    paths = sorted(item.relative_path for item in files)
    assert names == ["1.jpg", "题目.pdf"]
    assert paths == ["提交/1.jpg", "题目.pdf"]


def test_match_prefers_student_number_folder() -> None:
    matched, reason = match_work_file("1/第一页.jpg", ROSTER)
    assert reason is None
    assert matched is not None and matched.id == "a"

    matched, reason = match_work_file("99/第一页.jpg", ROSTER)
    assert matched is None
    assert reason is not None and "99" in reason

    matched, reason = match_work_file("99/1.jpg", ROSTER)
    assert matched is None
    assert "99" in (reason or "")


def test_match_filename_number_and_unique_name() -> None:
    matched, reason = match_work_file("2_课堂.pdf", ROSTER)
    assert reason is None
    assert matched is not None and matched.id == "b"

    matched, reason = match_work_file("提交/蕾丝员.png", ROSTER)
    assert reason is None
    assert matched is not None and matched.id == "a"

    matched, reason = match_work_file("page.jpg", ROSTER)
    assert matched is None


def test_normalize_official_questions_accepts_locked_format() -> None:
    questions = normalize_official_questions(
        [
            {
                "position": 2,
                "question_type": "subjective",
                "max_score": 26,
                "knowledge_points": ["等差数列"],
                "stem": "求通项",
                "standard_answer": "$a_n=2n+1$",
                "rubric": "满分 26 分。",
                "source": "extracted",
                "confidence": 1,
            },
            {
                "position": 1,
                "question_type": "objective",
                "max_score": 6,
                "knowledge_points": ["集合"],
                "stem": "求交集",
                "standard_answer": "A",
                "rubric": "选 A 得 6 分。",
                "source": "extracted",
                "confidence": 0.9,
            },
        ]
    )
    assert [item["position"] for item in questions] == [1, 2]
    assert questions[0]["question_type"] == "objective"
    assert questions[1]["max_score"] == 26


def test_normalize_official_questions_rejects_bad_type_and_gaps() -> None:
    with pytest.raises(ValueError, match="不支持的题型"):
        normalize_official_questions(
            [
                {
                    "position": 1,
                    "question_type": "single_choice",
                    "max_score": 6,
                    "stem": "题干",
                    "standard_answer": "A",
                    "rubric": "选 A 得分",
                }
            ]
        )
    with pytest.raises(ValueError, match="连续编号"):
        normalize_official_questions(
            [
                {
                    "position": 1,
                    "question_type": "objective",
                    "max_score": 6,
                    "stem": "题干",
                    "standard_answer": "A",
                    "rubric": "选 A 得分",
                },
                {
                    "position": 3,
                    "question_type": "objective",
                    "max_score": 6,
                    "stem": "题干",
                    "standard_answer": "B",
                    "rubric": "选 B 得分",
                },
            ]
        )
