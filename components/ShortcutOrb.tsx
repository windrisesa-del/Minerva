"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ThemePreference } from "@/hooks/useTheme";

const STORAGE_KEY = "pi-web:shortcut-orb";
const ORB_SIZE = 46;
const DRAG_THRESHOLD = 6;
const EDGE_PAD = 8;

interface Choice {
  id: string;
  label: string;
}

interface Props {
  themeLabel: string;
  themePreference: ThemePreference;
  themeOptions: Choice[];
  languageLabel: string;
  locale: string;
  locales: Choice[];
  titleLabel: string;
  titleHint: string;
  titleDisabled: boolean;
  titleBusy: boolean;
  titleSuccess: boolean;
  titleError: boolean;
  historyLabel: string;
  historyHint: string;
  historyDisabled: boolean;
  openLabel: string;
  closeLabel: string;
  onSetTheme: (preference: ThemePreference, origin: { x: number; y: number }) => void;
  onSetLocale: (locale: string) => void;
  onGenerateTitle: () => void;
  onViewHistory: () => void;
}

type Submenu = "theme" | "language" | null;
type Point = { left: number; top: number };

function ThemeGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function LanguageGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  );
}

function TitleGlyph({ busy, success }: { busy: boolean; success: boolean }) {
  if (busy) {
    return (
      <svg className="minerva-shortcut-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (success) {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m15 4 5 5L7 22l-5-5Z" />
      <path d="m14 5 5 5" />
      <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
    </svg>
  );
}

function HistoryGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

const ITEM_STRIDE = 47;
const MENU_WIDTH = 188;
const FLYOUT_WIDTH = 148;
const FLYOUT_GAP = 8;

function shouldOpenEnd(left: number, parentWidth: number): boolean {
  if (parentWidth <= 0) return false;
  const need = FLYOUT_WIDTH + FLYOUT_GAP + EDGE_PAD;
  const menuLeft = left + ORB_SIZE - MENU_WIDTH;
  const spaceLeft = menuLeft;
  const spaceRight = parentWidth - (left + ORB_SIZE);
  if (spaceLeft >= need) return false;
  if (spaceRight >= need) return true;
  return spaceRight > spaceLeft;
}

function SideChevron({ end }: { end: boolean }) {
  return (
    <svg className={`minerva-shortcut-chevron${end ? " is-end" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 6 9 12 15 18" />
    </svg>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredPosition(): Point | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const left = (parsed as { left?: unknown }).left;
    const top = (parsed as { top?: unknown }).top;
    if (typeof left !== "number" || typeof top !== "number" || !Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  } catch {
    return null;
  }
}

function writeStoredPosition(point: Point): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(point));
  } catch {
    // Browser storage is best-effort.
  }
}

function defaultPosition(parent: DOMRect): Point {
  const right = parent.width >= 768 ? 52 : 16;
  return {
    left: Math.max(EDGE_PAD, parent.width - right - ORB_SIZE),
    top: Math.max(EDGE_PAD, parent.height * 0.62 - ORB_SIZE / 2),
  };
}

function clampToParent(point: Point, parent: DOMRect): Point {
  return {
    left: clamp(point.left, EDGE_PAD, Math.max(EDGE_PAD, parent.width - ORB_SIZE - EDGE_PAD)),
    top: clamp(point.top, EDGE_PAD, Math.max(EDGE_PAD, parent.height - ORB_SIZE - EDGE_PAD)),
  };
}

export function ShortcutOrb({
  themeLabel,
  themePreference,
  themeOptions,
  languageLabel,
  locale,
  locales,
  titleLabel,
  titleHint,
  titleDisabled,
  titleBusy,
  titleSuccess,
  titleError,
  historyLabel,
  historyHint,
  historyDisabled,
  openLabel,
  closeLabel,
  onSetTheme,
  onSetLocale,
  onGenerateTitle,
  onViewHistory,
}: Props) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu>(null);
  const [position, setPosition] = useState<Point | null>(null);
  const [parentWidth, setParentWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originLeft: number;
    originTop: number;
    moved: boolean;
  } | null>(null);

  const parentRect = useCallback(() => {
    return rootRef.current?.offsetParent?.getBoundingClientRect() ?? null;
  }, []);

  useLayoutEffect(() => {
    const parent = parentRect();
    if (!parent) return;
    setParentWidth(parent.width);
    const stored = readStoredPosition();
    setPosition(clampToParent(stored ?? defaultPosition(parent), parent));
  }, [parentRect]);

  useEffect(() => {
    const parentEl = rootRef.current?.offsetParent;
    if (!parentEl) return;
    const ro = new ResizeObserver(() => {
      const nextParent = parentEl.getBoundingClientRect();
      setParentWidth(nextParent.width);
      setPosition((current) => current ? clampToParent(current, nextParent) : current);
    });
    ro.observe(parentEl);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!open) setSubmenu(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.composedPath().includes(root)) return;
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (submenu) setSubmenu(null);
      else setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, submenu]);

  const toggleSubmenu = (next: Submenu) => {
    setSubmenu((current) => current === next ? null : next);
  };

  const handleOrbPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const parent = parentRect();
    if (!parent || position === null) return;
    event.preventDefault();
    const orbEl = event.currentTarget;
    const drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originLeft: position.left,
      originTop: position.top,
      moved: false,
    };
    dragRef.current = drag;
    try {
      orbEl.setPointerCapture(event.pointerId);
    } catch {
      // Untrusted or unsupported capture still allows window-level tracking.
    }

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== drag.pointerId) return;
      const nextParent = parentRect();
      if (!nextParent) return;
      const dx = moveEvent.clientX - drag.startX;
      const dy = moveEvent.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!drag.moved) {
        drag.moved = true;
        setDragging(true);
        setOpen(false);
      }
      setPosition(clampToParent({
        left: drag.originLeft + dx,
        top: drag.originTop + dy,
      }, nextParent));
    };

    const handleUp = (upEvent: PointerEvent | MouseEvent) => {
      if ("pointerId" in upEvent && upEvent.pointerId !== drag.pointerId) return;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
      window.removeEventListener("mouseup", handleUp);
      dragRef.current = null;
      if ("pointerId" in upEvent && orbEl.hasPointerCapture?.(upEvent.pointerId)) {
        try {
          orbEl.releasePointerCapture(upEvent.pointerId);
        } catch {
          // Capture may already have been released.
        }
      }
      if (drag.moved) {
        setDragging(false);
        setPosition((current) => {
          if (current) writeStoredPosition(current);
          return current;
        });
        return;
      }
      setOpen((current) => !current);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    window.addEventListener("mouseup", handleUp);
  };

  const themeHint = themeOptions.find((option) => option.id === themePreference)?.label ?? themePreference;
  const languageHint = locales.find((option) => option.id === locale)?.label ?? locale;
  const flyoutEnd = Boolean(position && shouldOpenEnd(position.left, parentWidth));
  const openBelow = Boolean(position && position.top < 250);
  const flyoutChoices = submenu === "theme" ? themeOptions : submenu === "language" ? locales : [];
  const flyoutSelected = submenu === "theme" ? themePreference : locale;

  return (
    <div
      ref={rootRef}
      className={`minerva-shortcut${open ? " is-open" : ""}${dragging ? " is-dragging" : ""}`}
      style={position ? { left: position.left, top: position.top, right: "auto", bottom: "auto" } : undefined}
    >
      {open && (
        <div className={`minerva-shortcut-panels${flyoutEnd ? " is-end" : ""}${openBelow ? " is-below" : ""}`}>
          <div className="minerva-shortcut-menu" role="menu" aria-label={openLabel}>
            <button
              type="button"
              role="menuitem"
              className={`minerva-shortcut-item${submenu === "theme" ? " is-expanded" : ""}`}
              aria-expanded={submenu === "theme"}
              aria-haspopup="menu"
              title={themeLabel}
              onClick={() => toggleSubmenu("theme")}
            >
              <span className="minerva-shortcut-icon"><ThemeGlyph /></span>
              <span className="minerva-shortcut-copy">
                <span className="minerva-shortcut-label">{themeLabel}</span>
                {themeHint !== themeLabel && <span className="minerva-shortcut-hint">{themeHint}</span>}
              </span>
              <SideChevron end={flyoutEnd} />
            </button>
            <button
              type="button"
              role="menuitem"
              className={`minerva-shortcut-item${submenu === "language" ? " is-expanded" : ""}`}
              aria-expanded={submenu === "language"}
              aria-haspopup="menu"
              title={languageLabel}
              onClick={() => toggleSubmenu("language")}
            >
              <span className="minerva-shortcut-icon"><LanguageGlyph /></span>
              <span className="minerva-shortcut-copy">
                <span className="minerva-shortcut-label">{languageLabel}</span>
                {languageHint !== languageLabel && <span className="minerva-shortcut-hint">{languageHint}</span>}
              </span>
              <SideChevron end={flyoutEnd} />
            </button>
            <button
              type="button"
              role="menuitem"
              className={`minerva-shortcut-item${titleError ? " is-error" : ""}${titleSuccess ? " is-success" : ""}`}
              title={titleHint}
              disabled={titleDisabled}
              onClick={onGenerateTitle}
            >
              <span className="minerva-shortcut-icon"><TitleGlyph busy={titleBusy} success={titleSuccess} /></span>
              <span className="minerva-shortcut-copy">
                <span className="minerva-shortcut-label">{titleLabel}</span>
                {titleHint !== titleLabel && <span className="minerva-shortcut-hint">{titleHint}</span>}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="minerva-shortcut-item"
              title={historyHint}
              disabled={historyDisabled}
              onClick={() => {
                onViewHistory();
                setOpen(false);
              }}
            >
              <span className="minerva-shortcut-icon"><HistoryGlyph /></span>
              <span className="minerva-shortcut-copy">
                <span className="minerva-shortcut-label">{historyLabel}</span>
                {historyHint !== historyLabel && <span className="minerva-shortcut-hint">{historyHint}</span>}
              </span>
            </button>
          </div>
          {submenu && (
            <div
              className="minerva-shortcut-options minerva-shortcut-flyout"
              role="menu"
              aria-label={submenu === "theme" ? themeLabel : languageLabel}
              style={{ top: submenu === "theme" ? 0 : ITEM_STRIDE }}
            >
              {flyoutChoices.map((option) => {
                const selected = option.id === flyoutSelected;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className={`minerva-shortcut-option${selected ? " is-selected" : ""}`}
                    onClick={(event) => {
                      if (submenu === "theme") {
                        const rect = event.currentTarget.getBoundingClientRect();
                        onSetTheme(option.id as ThemePreference, {
                          x: rect.left + rect.width / 2,
                          y: rect.top + rect.height / 2,
                        });
                      } else {
                        onSetLocale(option.id);
                      }
                      setSubmenu(null);
                    }}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="minerva-shortcut-orb"
        title={open ? closeLabel : openLabel}
        aria-label={open ? closeLabel : openLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        onPointerDown={handleOrbPointerDown}
      >
        {open ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="8" r="2.1" />
            <circle cx="16" cy="8" r="2.1" />
            <circle cx="8" cy="16" r="2.1" />
            <circle cx="16" cy="16" r="2.1" />
          </svg>
        )}
      </button>
    </div>
  );
}
