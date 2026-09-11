"use client";

import type { Core, EventObject, NodeSingular } from "cytoscape";
import { useEffect, useMemo, useRef, useState } from "react";

type WikiPage = {
  page_id?: string | number;
  title?: string;
  description?: string;
  path?: string;
  locale?: string;
  url?: string;
};

type GraphNode = {
  id: string;
  type: "student" | "subject" | "domain" | "knowledge";
  label: string;
  subject?: string;
  knowledge_domain?: string;
  knowledge_id?: string;
  mastery_level?: number | null;
  mastery_reason?: string;
  mastered_parts?: string[];
  unmastered_parts?: string[];
  mastery_boundaries?: string[];
  common_errors?: string[];
  wiki_page?: WikiPage | null;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: "contains" | "wiki" | "mastery";
};

type KnowledgeGraph = {
  student_id: string;
  student_name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  wiki: {
    status: "connected" | "unconfigured" | "unavailable";
    url: string;
    page_count: number;
    matched_count: number;
    message: string;
  };
};

function masteryLabel(level?: number | null) {
  return level ? `${level} / 5 星` : "尚未评估";
}
function fitGraph(core: Core) {
  core.fit(undefined, 34);
  if (core.zoom() > 1.5) {
    core.zoom(1.5);
    core.center();
  }
}

function nodeDirectionSeed(id: string) {
  let seed = 0;
  for (const character of id) seed = (seed * 31 + character.charCodeAt(0)) % 360;
  return seed * Math.PI / 180;
}

function pullConnectedNodesAlongDrag(
  dragged: NodeSingular,
  delta: { x: number; y: number },
) {
  const core = dragged.cy();
  const queue: Array<{ node: NodeSingular; depth: number }> = [{ node: dragged, depth: 0 }];
  const visited = new Set([dragged.id()]);

  core.batch(() => {
    while (queue.length) {
      const current = queue.shift();
      if (!current || current.depth >= 2) continue;
      const depth = current.depth + 1;
      const strength = 0.36 ** depth;

      current.node.connectedEdges().connectedNodes().forEach((connected) => {
        const node = connected as NodeSingular;
        if (visited.has(node.id()) || node.grabbed() || node.locked()) return;
        const position = node.position();
        node.position({
          x: position.x + delta.x * strength,
          y: position.y + delta.y * strength,
        });
        visited.add(node.id());
        queue.push({ node, depth });
      });
    }
  });
}

function repelNodesAlongDrag(dragged: NodeSingular) {
  const core = dragged.cy();
  const radius = 54 / Math.max(core.zoom(), 0.35);
  const queue: Array<{ node: NodeSingular; depth: number }> = [{ node: dragged, depth: 0 }];
  const moved = new Set([dragged.id()]);

  core.batch(() => {
    while (queue.length) {
      const current = queue.shift();
      if (!current || current.depth >= 3) continue;
      const origin = current.node.position();
      core.nodes().forEach((candidate) => {
        if (moved.has(candidate.id()) || candidate.grabbed() || candidate.locked()) return;
        const position = candidate.position();
        let dx = position.x - origin.x;
        let dy = position.y - origin.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= radius) return;
        if (distance < 0.01) {
          const angle = nodeDirectionSeed(candidate.id());
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const displacement = (radius - distance) * 0.72;
        candidate.position({
          x: position.x + dx / distance * displacement,
          y: position.y + dy / distance * displacement,
        });
        moved.add(candidate.id());
        queue.push({ node: candidate, depth: current.depth + 1 });
      });
    }
  });
}

function NodeDetails({ node }: { node: GraphNode | null }) {
  if (!node) {
    return <p className="student-wiki-hint">选择一个知识点，查看掌握依据与知识页面。</p>;
  }
  if (node.type === "subject" || node.type === "domain") {
    return (
      <div className="student-wiki-details">
        <div>
          <span>{node.type === "subject" ? "学科" : "知识大块"}</span>
          <h4>{node.label}</h4>
          {node.type === "domain" && node.subject ? <p>{node.subject}</p> : null}
        </div>
        <p className="student-wiki-reason">
          {node.type === "subject"
            ? "该学科下的知识大块与具体知识点，会按作业分析中的分类展开。"
            : "该知识大块下的具体知识点带有学生掌握程度。"}
        </p>
      </div>
    );
  }
  if (node.type !== "knowledge") {
    return <p className="student-wiki-hint">选择一个知识点，查看掌握依据与知识页面。</p>;
  }
  return (
    <div className="student-wiki-details">
      <div>
        <span>当前知识点</span>
        <h4>{node.label}</h4>
        <p>
          {[node.subject, node.knowledge_domain, node.knowledge_id].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div className="student-wiki-mastery">
        <strong>{masteryLabel(node.mastery_level)}</strong>
        <span aria-label={`${node.mastery_level ?? 0} 星掌握程度`}>
          {[1, 2, 3, 4, 5].map((star) => (
            <i key={star} className={star <= (node.mastery_level ?? 0) ? "is-active" : undefined}>★</i>
          ))}
        </span>
      </div>
      <p className="student-wiki-reason">{node.mastery_reason || "暂无掌握程度依据。"}</p>
      {node.wiki_page?.url ? (
        <a href={node.wiki_page.url} target="_blank" rel="noreferrer">
          打开 Wiki 知识页 <span aria-hidden="true">↗</span>
        </a>
      ) : (
        <small>尚未关联 Wiki 知识页</small>
      )}
    </div>
  );
}

export function StudentKnowledgeGraph({ studentId }: { studentId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const coreRef = useRef<Core | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setGraph(null);
    setError(null);
    fetch(`/api/wiki/knowledge-graph?studentId=${encodeURIComponent(studentId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json() as KnowledgeGraph & { error?: string; detail?: string };
        if (!response.ok) throw new Error(body.error || body.detail || `HTTP ${response.status}`);
        return body;
      })
      .then((body) => {
        setGraph(body);
        setSelectedId(body.nodes.find((node) => node.type === "knowledge")?.id ?? null);
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "知识图谱载入失败");
      });
    return () => controller.abort();
  }, [studentId]);

  useEffect(() => {
    if (!graph || !containerRef.current) return;
    let disposed = false;
    const container = containerRef.current;
    let resizeObserver: ResizeObserver | null = null;
    let inertiaFrame: number | null = null;

    void import("cytoscape").then(({ default: cytoscape }) => {
      if (disposed) return;
      const styles = getComputedStyle(document.documentElement);
      const text = styles.getPropertyValue("--text").trim() || "#292622";
      const border = styles.getPropertyValue("--border").trim() || "#ddd5c9";
      const accent = styles.getPropertyValue("--accent").trim() || "#c96f50";
      const panel = styles.getPropertyValue("--bg-panel").trim() || "#f4efe7";
      const core = cytoscape({
        container,
        pixelRatio: Math.max(2, window.devicePixelRatio),
        elements: [
          ...graph.nodes.map((node) => ({
            data: node,
            classes: `${node.type} mastery-${node.mastery_level ?? "unknown"}`,
          })),
          ...graph.edges.map((edge) => ({ data: edge, classes: edge.type })),
        ],
        style: [
          {
            selector: "node",
            style: {
              "background-color": "#aaa6a1",
              "border-color": panel,
              "border-width": 1,
              color: text,
              label: "data(label)",
              "font-family": "inherit",
              "font-size": 9,
              "font-weight": 500,
              "min-zoomed-font-size": 8,
              height: 10,
              shape: "ellipse",
              "text-halign": "center",
              "text-margin-y": 8,
              "text-max-width": "130px",
              "text-valign": "bottom",
              "text-wrap": "ellipsis",
              width: 10,
            },
          },
          {
            selector: "node.student",
            style: {
              "background-color": text,
              "border-color": panel,
              "border-width": 2,
              "font-weight": 650,
              height: 18,
              width: 18,
            },
          },
          {
            selector: "node.subject",
            style: {
              "background-color": accent,
              "border-color": panel,
              "border-width": 2,
              "font-weight": 650,
              height: 14,
              shape: "ellipse",
              width: 14,
            },
          },
          {
            selector: "node.domain",
            style: {
              "background-color": "#a89078",
              "border-color": panel,
              "border-width": 1.5,
              "font-weight": 600,
              height: 12,
              shape: "ellipse",
              width: 12,
            },
          },
          { selector: "node.mastery-1", style: { "background-color": "#c95f5f" } },
          { selector: "node.mastery-2", style: { "background-color": "#d98557" } },
          { selector: "node.mastery-3", style: { "background-color": "#d5af4e" } },
          { selector: "node.mastery-4", style: { "background-color": "#9caf5f" } },
          { selector: "node.mastery-5", style: { "background-color": "#5f9f72" } },
          { selector: "node.labels-hidden", style: { label: "" } },
          {
            selector: "node:selected",
            style: { "border-color": accent, "border-width": 2, "overlay-opacity": 0 },
          },
          {
            selector: "edge",
            style: {
              "curve-style": "bezier",
              "line-color": border,
              opacity: 0.62,
              "target-arrow-shape": "none",
              width: 0.8,
            },
          },
          {
            selector: "edge.contains",
            style: {
              "line-color": border,
              opacity: 0.78,
              width: 1.1,
            },
          },
          {
            selector: "edge.wiki",
            style: { "line-color": accent, "line-style": "dashed", opacity: 0.66, width: 1.5 },
          },
        ],
        layout: {
          name: "cose",
          animate: false,
          fit: true,
          padding: 34,
          nodeRepulsion: () => 90000,
          idealEdgeLength: () => 120,
          nodeOverlap: 18,
          componentSpacing: 140,
          gravity: 0.2,
          numIter: 1400,
        },
        minZoom: 0.35,
        maxZoom: 3,
        wheelSensitivity: 4.41,
      });
      const syncLabelVisibility = () => {
        core.nodes().toggleClass("labels-hidden", core.zoom() < 0.78);
      };
      core.on("zoom", syncLabelVisibility);
      fitGraph(core);
      syncLabelVisibility();
      const dragMotion = new Map<string, {
        x: number;
        y: number;
        time: number;
        velocityX: number;
        velocityY: number;
      }>();
      const stopInertia = () => {
        if (inertiaFrame !== null) cancelAnimationFrame(inertiaFrame);
        inertiaFrame = null;
      };
      const startInertia = (node: NodeSingular, initialX: number, initialY: number) => {
        stopInertia();
        const maximumSpeed = 1.35;
        const initialSpeed = Math.hypot(initialX, initialY);
        const scale = initialSpeed > maximumSpeed ? maximumSpeed / initialSpeed : 1;
        let velocityX = initialX * scale;
        let velocityY = initialY * scale;
        let previousTime = performance.now();

        const step = (time: number) => {
          if (disposed || node.removed() || node.grabbed()) {
            inertiaFrame = null;
            return;
          }
          const elapsed = Math.min(Math.max(time - previousTime, 1), 32);
          const delta = { x: velocityX * elapsed, y: velocityY * elapsed };
          const position = node.position();
          node.position({ x: position.x + delta.x, y: position.y + delta.y });
          pullConnectedNodesAlongDrag(node, delta);
          repelNodesAlongDrag(node);

          const friction = 0.9 ** (elapsed / 16.67);
          velocityX *= friction;
          velocityY *= friction;
          previousTime = time;
          if (Math.hypot(velocityX, velocityY) < 0.012) {
            inertiaFrame = null;
            return;
          }
          inertiaFrame = requestAnimationFrame(step);
        };

        if (initialSpeed >= 0.012) inertiaFrame = requestAnimationFrame(step);
      };
      core.on("grab", "node", (event: EventObject) => {
        stopInertia();
        const node = event.target as NodeSingular;
        dragMotion.set(node.id(), {
          x: node.position().x,
          y: node.position().y,
          time: performance.now(),
          velocityX: 0,
          velocityY: 0,
        });
      });
      core.on("drag", "node", (event: EventObject) => {
        const node = event.target as NodeSingular;
        const previous = dragMotion.get(node.id());
        const now = performance.now();
        const position = node.position();
        if (previous) {
          const elapsed = Math.max(now - previous.time, 1);
          const delta = { x: position.x - previous.x, y: position.y - previous.y };
          pullConnectedNodesAlongDrag(node, delta);
          repelNodesAlongDrag(node);
          dragMotion.set(node.id(), {
            x: position.x,
            y: position.y,
            time: now,
            velocityX: delta.x / elapsed,
            velocityY: delta.y / elapsed,
          });
        }
      });
      core.on("free", "node", (event: EventObject) => {
        const node = event.target as NodeSingular;
        const motion = dragMotion.get(node.id());
        dragMotion.delete(node.id());
        if (motion) startInertia(node, motion.velocityX, motion.velocityY);
      });
      core.on("tap", "node.knowledge, node.subject, node.domain", (event: EventObject) => {
        setSelectedId((event.target as NodeSingular).id());
      });
      coreRef.current = core;
      resizeObserver = new ResizeObserver(() => {
        core.resize();
        fitGraph(core);
      });
      resizeObserver.observe(container);
    });

    return () => {
      disposed = true;
      if (inertiaFrame !== null) cancelAnimationFrame(inertiaFrame);
      resizeObserver?.disconnect();
      coreRef.current?.destroy();
      coreRef.current = null;
    };
  }, [graph]);

  const selectedNode = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedId) ?? null,
    [graph, selectedId],
  );
  const pointCount = graph?.nodes.filter((node) => node.type === "knowledge").length ?? 0;

  return (
    <section className="student-wiki-graph" aria-labelledby="student-wiki-title">
      <header className="student-wiki-header">
        <div>
          <h3 id="student-wiki-title">知识掌握图谱</h3>
          <p>按学生 → 学科 → 知识大块 → 知识点展开；颜色表示掌握程度，虚线是 Wiki 页面关联。</p>
        </div>
        {graph && (
          <span className={`student-wiki-status is-${graph.wiki.status}`} title={graph.wiki.message}>
            {graph.wiki.status === "connected"
              ? `Wiki 已连接 · ${graph.wiki.matched_count}/${pointCount}`
              : graph.wiki.status === "unconfigured" ? "Wiki 待配置" : "Wiki 暂不可用"}
          </span>
        )}
      </header>
      {error ? (
        <p className="student-wiki-empty" role="alert">{error}</p>
      ) : !graph ? (
        <div className="student-wiki-loading" aria-label="正在载入知识图谱"><span /><span /><span /></div>
      ) : pointCount === 0 ? (
        <p className="student-wiki-empty">Evaluator 尚未为这名学生形成知识点画像。</p>
      ) : (
        <div className="student-wiki-layout">
          <div className="student-wiki-canvas-wrap">
            <div ref={containerRef} className="student-wiki-canvas" aria-label={`${graph.student_name}的知识掌握图谱`} />
            <button type="button" onClick={() => { if (coreRef.current) fitGraph(coreRef.current); }}>适应视图</button>
          </div>
          <NodeDetails node={selectedNode} />
        </div>
      )}
      <div className="student-wiki-legend" aria-label="掌握程度图例">
        <span><i className="level-subject" />学科</span>
        <span><i className="level-domain" />知识大块</span>
        <span><i className="level-1" />1 星</span>
        <span><i className="level-2" />2 星</span>
        <span><i className="level-3" />3 星</span>
        <span><i className="level-4" />4 星</span>
        <span><i className="level-5" />5 星</span>
        <span><b />Wiki 关系</span>
      </div>
    </section>
  );
}
