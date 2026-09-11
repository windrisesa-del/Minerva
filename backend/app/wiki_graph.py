from __future__ import annotations

import json
import os
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from .minerva_tools import _canonical_description
from .models import AssignmentItem, Student, StudentObservation, Submission


WIKI_GRAPH_QUERY = """
query MinervaKnowledgeGraph($locale: String!) {
  pages {
    list(orderBy: TITLE, orderByDirection: ASC) {
      id
      path
      locale
      title
      description
      isPublished
      isPrivate
      tags
      updatedAt
    }
    links(locale: $locale) {
      id
      path
      title
      links
    }
  }
}
"""

DEFAULT_SUBJECT = "未分科"
DEFAULT_DOMAIN = "未分类"


def _wiki_settings() -> dict[str, str]:
    base_url = os.getenv("WIKIJS_URL", "http://127.0.0.1:3002").rstrip("/")
    return {
        "url": base_url,
        "public_url": os.getenv("WIKIJS_PUBLIC_URL", base_url).rstrip("/"),
        "locale": os.getenv("WIKIJS_LOCALE", "zh").strip() or "zh",
        "token": os.getenv("WIKIJS_API_TOKEN", "").strip(),
    }


def _fetch_wiki_snapshot() -> dict[str, Any]:
    settings = _wiki_settings()
    if not settings["token"]:
        return {
            "status": "unconfigured",
            "url": settings["public_url"],
            "pages": [],
            "links": [],
            "message": "Wiki.js 已启动，配置只读 API Token 后即可关联知识页面。",
        }

    body = json.dumps(
        {"query": WIKI_GRAPH_QUERY, "variables": {"locale": settings["locale"]}}
    ).encode("utf-8")
    request = Request(
        f'{settings["url"]}/graphql',
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f'Bearer {settings["token"]}',
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError):
        return {
            "status": "unavailable",
            "url": settings["public_url"],
            "pages": [],
            "links": [],
            "message": "暂时无法读取 Wiki.js，当前仍显示 Minerva 学生画像中的知识点。",
        }

    if payload.get("errors"):
        return {
            "status": "unavailable",
            "url": settings["public_url"],
            "pages": [],
            "links": [],
            "message": "Wiki.js 拒绝了知识页读取请求，请检查 API Token 权限与语言设置。",
        }
    pages_root = ((payload.get("data") or {}).get("pages") or {})
    return {
        "status": "connected",
        "url": settings["public_url"],
        "pages": pages_root.get("list") or [],
        "links": pages_root.get("links") or [],
        "message": "Wiki.js 知识页面已连接。",
    }


def _normalized_key(value: Any) -> str:
    text = str(value or "").strip().casefold().replace("_", "-")
    text = re.sub(r"\s+", "-", text)
    return re.sub(r"[^\w\-\u3400-\u9fff]", "", text)


def _page_url(base_url: str, page: dict[str, Any]) -> str:
    locale = quote(str(page.get("locale") or "zh").strip(), safe="")
    path = "/".join(quote(part, safe="") for part in str(page.get("path") or "").split("/") if part)
    return f"{base_url}/{locale}/{path}" if path else f"{base_url}/{locale}"


def _match_page(
    knowledge_id: str,
    knowledge_name: str,
    pages: list[dict[str, Any]],
) -> dict[str, Any] | None:
    tag = f"minerva:{knowledge_id}".casefold()
    normalized_id = _normalized_key(knowledge_id)
    normalized_name = _normalized_key(knowledge_name)
    for page in pages:
        tags = {str(value).strip().casefold() for value in page.get("tags") or []}
        if tag in tags:
            return page
    for page in pages:
        final_path = str(page.get("path") or "").rstrip("/").rsplit("/", 1)[-1]
        if normalized_id and _normalized_key(final_path) == normalized_id:
            return page
    for page in pages:
        if normalized_name and _normalized_key(page.get("title")) == normalized_name:
            return page
    return None


def _link_path(value: Any) -> str:
    path = str(value or "").strip().strip("/")
    if not path:
        return ""
    parts = path.split("/")
    if len(parts) > 1 and len(parts[0]) in (2, 5):
        path = "/".join(parts[1:])
    return _normalized_key(path)


def _clean_label(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text or fallback


def _concept_ids_from_snapshot(snapshot: dict[str, Any]) -> list[str]:
    analysis = snapshot.get("analysis") if isinstance(snapshot.get("analysis"), dict) else {}
    seen: set[str] = set()
    concepts: list[str] = []
    for raw in list(snapshot.get("knowledge_points") or []) + list(analysis.get("main_concepts") or []):
        value = str(raw).strip()
        if value and value not in seen:
            seen.add(value)
            concepts.append(value)
    if concepts:
        return concepts
    domain = str(analysis.get("knowledge_domain") or "").strip()
    return [domain] if domain else []


def _ingest_taxonomy_snapshot(
    snapshot: Any,
    mapping: dict[str, dict[str, str]],
    knowledge_ids: set[str],
    *,
    overwrite: bool = False,
) -> None:
    if not isinstance(snapshot, dict):
        return
    analysis = snapshot.get("analysis") if isinstance(snapshot.get("analysis"), dict) else {}
    subject = _clean_label(analysis.get("subject"), DEFAULT_SUBJECT)
    domain = _clean_label(analysis.get("knowledge_domain"), DEFAULT_DOMAIN)
    for knowledge_id in _concept_ids_from_snapshot(snapshot):
        if knowledge_id not in knowledge_ids:
            continue
        if knowledge_id in mapping and not overwrite:
            continue
        mapping[knowledge_id] = {
            "subject": subject,
            "knowledge_domain": domain,
        }


def _taxonomy_for_knowledge_ids(
    session: Session,
    student_id: UUID,
    knowledge_ids: set[str],
    points: dict[str, Any],
) -> dict[str, dict[str, str]]:
    mapping: dict[str, dict[str, str]] = {}
    for knowledge_id, raw_point in points.items():
        if knowledge_id not in knowledge_ids or not isinstance(raw_point, dict):
            continue
        subject = str(raw_point.get("subject") or "").strip()
        domain = str(raw_point.get("knowledge_domain") or "").strip()
        if subject or domain:
            mapping[str(knowledge_id)] = {
                "subject": subject or DEFAULT_SUBJECT,
                "knowledge_domain": domain or DEFAULT_DOMAIN,
            }

    if not knowledge_ids:
        return mapping

    student_snapshots = session.scalars(
        select(AssignmentItem.question_snapshot)
        .join(Submission, Submission.assignment_id == AssignmentItem.assignment_id)
        .where(Submission.student_id == student_id)
    ).all()
    for snapshot in student_snapshots:
        _ingest_taxonomy_snapshot(snapshot, mapping, knowledge_ids)

    missing = {knowledge_id for knowledge_id in knowledge_ids if knowledge_id not in mapping}
    if missing:
        for snapshot in session.scalars(select(AssignmentItem.question_snapshot)).all():
            _ingest_taxonomy_snapshot(snapshot, mapping, missing)
            missing = {knowledge_id for knowledge_id in knowledge_ids if knowledge_id not in mapping}
            if not missing:
                break

    # Soft-fill from known domains: e.g. knowledge "函数平移" under domain "函数".
    catalog: list[tuple[str, str, str]] = []
    seen_catalog: set[tuple[str, str]] = set()
    for snapshot in session.scalars(select(AssignmentItem.question_snapshot)).all():
        if not isinstance(snapshot, dict):
            continue
        analysis = snapshot.get("analysis") if isinstance(snapshot.get("analysis"), dict) else {}
        subject = _clean_label(analysis.get("subject"), DEFAULT_SUBJECT)
        domain = _clean_label(analysis.get("knowledge_domain"), DEFAULT_DOMAIN)
        key = (subject, domain)
        if domain == DEFAULT_DOMAIN or key in seen_catalog:
            continue
        seen_catalog.add(key)
        catalog.append((subject, domain, _normalized_key(domain)))

    catalog.sort(key=lambda item: len(item[2]), reverse=True)
    for knowledge_id in knowledge_ids:
        if knowledge_id in mapping and mapping[knowledge_id]["knowledge_domain"] != DEFAULT_DOMAIN:
            continue
        point = points.get(knowledge_id) if isinstance(points.get(knowledge_id), dict) else {}
        candidates = [
            _normalized_key(knowledge_id),
            _normalized_key((point or {}).get("knowledge_name")),
        ]
        matched = None
        for subject, domain, domain_key in catalog:
            if not domain_key:
                continue
            if any(candidate == domain_key or candidate.startswith(domain_key) for candidate in candidates if candidate):
                matched = {"subject": subject, "knowledge_domain": domain}
                break
        if matched:
            mapping[knowledge_id] = matched

    for knowledge_id in knowledge_ids:
        mapping.setdefault(
            knowledge_id,
            {"subject": DEFAULT_SUBJECT, "knowledge_domain": DEFAULT_DOMAIN},
        )
    return mapping


def build_student_knowledge_graph(session: Session, student_id: UUID) -> dict[str, Any]:
    student = session.get(Student, student_id)
    if student is None:
        raise LookupError("学生不存在")

    observation = session.get(StudentObservation, student_id)
    description = _canonical_description(observation.description if observation else {})
    raw_points = description["knowledge_profile"].get("knowledge_points", {})
    points = raw_points if isinstance(raw_points, dict) else {}
    knowledge_ids = {str(knowledge_id) for knowledge_id in points}
    taxonomy = _taxonomy_for_knowledge_ids(session, student_id, knowledge_ids, points)
    wiki = _fetch_wiki_snapshot()
    published_pages = [
        page
        for page in wiki["pages"]
        if isinstance(page, dict) and page.get("isPublished", True)
    ]

    student_node_id = f"student:{student.id}"
    nodes: list[dict[str, Any]] = [
        {
            "id": student_node_id,
            "type": "student",
            "label": student.name,
            "student_id": str(student.id),
        }
    ]
    edges: list[dict[str, Any]] = []
    page_to_node: dict[str, str] = {}
    matched_count = 0
    subject_nodes: dict[str, str] = {}
    domain_nodes: dict[tuple[str, str], str] = {}

    def ensure_subject(subject: str) -> str:
        if subject in subject_nodes:
            return subject_nodes[subject]
        node_id = f"subject:{_normalized_key(subject) or 'unknown'}"
        subject_nodes[subject] = node_id
        nodes.append(
            {
                "id": node_id,
                "type": "subject",
                "label": subject,
                "subject": subject,
            }
        )
        edges.append(
            {
                "id": f"contains:{student_node_id}:{node_id}",
                "source": student_node_id,
                "target": node_id,
                "type": "contains",
            }
        )
        return node_id

    def ensure_domain(subject: str, domain: str) -> str:
        key = (subject, domain)
        if key in domain_nodes:
            return domain_nodes[key]
        subject_node_id = ensure_subject(subject)
        node_id = f"domain:{_normalized_key(subject) or 'unknown'}:{_normalized_key(domain) or 'unknown'}"
        domain_nodes[key] = node_id
        nodes.append(
            {
                "id": node_id,
                "type": "domain",
                "label": domain,
                "subject": subject,
                "knowledge_domain": domain,
            }
        )
        edges.append(
            {
                "id": f"contains:{subject_node_id}:{node_id}",
                "source": subject_node_id,
                "target": node_id,
                "type": "contains",
            }
        )
        return node_id

    for knowledge_id, raw_point in points.items():
        point = raw_point if isinstance(raw_point, dict) else {}
        knowledge_name = str(point.get("knowledge_name") or knowledge_id).strip()
        placement = taxonomy.get(
            str(knowledge_id),
            {"subject": DEFAULT_SUBJECT, "knowledge_domain": DEFAULT_DOMAIN},
        )
        subject = placement["subject"]
        domain = placement["knowledge_domain"]
        domain_node_id = ensure_domain(subject, domain)
        page = _match_page(str(knowledge_id), knowledge_name, published_pages)
        wiki_page = None
        node_id = f"knowledge:{knowledge_id}"
        if page:
            matched_count += 1
            wiki_page = {
                "page_id": page.get("id"),
                "title": page.get("title"),
                "description": page.get("description") or "",
                "path": page.get("path"),
                "locale": page.get("locale"),
                "url": _page_url(wiki["url"], page),
            }
            page_to_node[str(page.get("id"))] = node_id
            page_to_node[_link_path(page.get("path"))] = node_id
        nodes.append(
            {
                "id": node_id,
                "type": "knowledge",
                "label": knowledge_name,
                "knowledge_id": str(knowledge_id),
                "subject": subject,
                "knowledge_domain": domain,
                "mastery_level": point.get("mastery_level"),
                "mastery_reason": str(point.get("mastery_reason") or ""),
                "mastered_parts": point.get("mastered_parts") or [],
                "unmastered_parts": point.get("unmastered_parts") or [],
                "mastery_boundaries": point.get("mastery_boundaries") or [],
                "common_errors": point.get("common_errors") or [],
                "wiki_page": wiki_page,
            }
        )
        edges.append(
            {
                "id": f"contains:{domain_node_id}:{node_id}",
                "source": domain_node_id,
                "target": node_id,
                "type": "contains",
            }
        )

    seen_relations: set[tuple[str, str]] = set()
    for page_links in wiki["links"]:
        if not isinstance(page_links, dict):
            continue
        source = page_to_node.get(str(page_links.get("id"))) or page_to_node.get(
            _link_path(page_links.get("path"))
        )
        if not source:
            continue
        for linked_path in page_links.get("links") or []:
            target = page_to_node.get(_link_path(linked_path))
            if not target or target == source:
                continue
            relation = tuple(sorted((source, target)))
            if relation in seen_relations:
                continue
            seen_relations.add(relation)
            edges.append(
                {
                    "id": f"wiki:{relation[0]}:{relation[1]}",
                    "source": relation[0],
                    "target": relation[1],
                    "type": "wiki",
                }
            )

    return {
        "student_id": str(student.id),
        "student_name": student.name,
        "nodes": nodes,
        "edges": edges,
        "wiki": {
            "status": wiki["status"],
            "url": wiki["url"],
            "page_count": len(published_pages),
            "matched_count": matched_count,
            "message": wiki["message"],
        },
    }
