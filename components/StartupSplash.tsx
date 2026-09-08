"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/hooks/useTheme";

interface StartupSplashProps {
  ready: boolean;
}

const EXIT_DURATION_MS = 480;
const FAILURE_ESCAPE_MS = 30_000;
const FIRST_SHIMMER_CYCLE_MS = 2_700;
const STARTUP_SEEN_KEY = "minerva-startup-seen";

export function StartupSplash({ ready }: StartupSplashProps) {
  const { toggleTheme } = useTheme();
  const shineRef = useRef<HTMLSpanElement>(null);
  const [cycleComplete, setCycleComplete] = useState(false);
  const [fallbackReady, setFallbackReady] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(STARTUP_SEEN_KEY) === "1") {
        setDismissed(true);
      }
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }, []);

  useEffect(() => {
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      const timer = window.setTimeout(() => setCycleComplete(true), 420);
      return () => window.clearTimeout(timer);
    }

    const shine = shineRef.current;
    const finishFirstCycle = (event?: AnimationEvent) => {
      if (event && event.animationName !== "minerva-startup-shimmer") return;
      setCycleComplete(true);
    };
    shine?.addEventListener("animationiteration", finishFirstCycle);
    const timer = window.setTimeout(finishFirstCycle, FIRST_SHIMMER_CYCLE_MS);

    return () => {
      shine?.removeEventListener("animationiteration", finishFirstCycle);
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setFallbackReady(true), FAILURE_ESCAPE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (leaving || !cycleComplete || (!ready && !fallbackReady)) return;
    try {
      window.sessionStorage.setItem(STARTUP_SEEN_KEY, "1");
    } catch {
      // The splash still exits normally when session storage is unavailable.
    }
    setLeaving(true);
  }, [cycleComplete, fallbackReady, leaving, ready]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setDismissed(true), EXIT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  if (dismissed) return null;

  return (
    <div
      className={`minerva-startup-splash${leaving ? " is-leaving" : ""}`}
      role="status"
      aria-label="Minerva 正在加载"
      aria-live="polite"
    >
      <button
        className="minerva-startup-theme"
        type="button"
        aria-label="切换主题"
        onClick={(event) => toggleTheme({ x: event.clientX, y: event.clientY })}
      >
        <svg className="minerva-startup-icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15.5 2.5a8.5 8.5 0 1 0 6 13.4A7 7 0 0 1 15.5 2.5z" />
        </svg>
        <svg className="minerva-startup-icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      </button>

      <div className="minerva-startup-stage">
        <span className="minerva-startup-mark" aria-hidden="true">
          <span ref={shineRef} className="minerva-startup-shine">Minerva</span>
          <span className="minerva-startup-dot">.</span>
        </span>
      </div>
    </div>
  );
}
