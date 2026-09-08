from __future__ import annotations

import json
from pathlib import Path
from uuid import UUID

from app.assignment_import import IncomingFile, import_ungraded_assignment, should_skip_path
from app.db import SessionLocal

CLASS_ID = UUID("5791f9fd-1b67-4a10-8b18-df5d3bc29224")
ROOT = Path(r"C:\Users\myjz_\Desktop\高中数学试题")
PAPERS = [
    ("A组 基础巩固卷", ROOT / "未批改作答" / "A", ROOT / "official" / "A组_基础巩固卷.json"),
    ("B组 中档训练卷", ROOT / "未批改作答" / "B", ROOT / "official" / "B组_中档训练卷.json"),
    ("C组 拔高挑战卷", ROOT / "未批改作答" / "C", ROOT / "official" / "C组_拔高挑战卷.json"),
]


def collect_folder(folder: Path) -> list[IncomingFile]:
    files: list[IncomingFile] = []
    for path in folder.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(folder).as_posix()
        if should_skip_path(relative):
            continue
        files.append(
            IncomingFile(
                original_name=path.name,
                content=path.read_bytes(),
                relative_path=relative,
            )
        )
    return files


def main() -> None:
    with SessionLocal() as session:
        for title, folder, json_path in PAPERS:
            payload = json.loads(json_path.read_text(encoding="utf-8"))
            questions = payload["questions"]
            total = sum(float(item["max_score"]) for item in questions)
            if len(questions) != 9 or abs(total - 100) > 1e-6:
                raise SystemExit(f"{json_path.name} 应为 9 题满分 100，实际 {len(questions)} 题 {total} 分")
            files = collect_folder(folder)
            result = import_ungraded_assignment(
                session,
                title=title,
                class_id=CLASS_ID,
                files=files,
                questions=questions,
            )
            print(result)


if __name__ == "__main__":
    main()
