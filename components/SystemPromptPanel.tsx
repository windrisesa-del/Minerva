type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  loading: boolean;
  prompt: string | null;
  translate: Translate;
}

export function SystemPromptPanel({ loading, prompt, translate }: Props) {
  return (
    <section className="system-prompt-panel" aria-label={translate("system.prompt")}>
      <div className="system-prompt-scroll">
        {prompt ? (
          <div className="system-prompt-text">{prompt}</div>
        ) : (
          <div className="system-prompt-empty">
            {prompt === ""
              ? translate("system.empty")
              : loading
                ? translate("system.loading")
                : translate("system.load")}
          </div>
        )}
      </div>

      <style>{`
        .system-prompt-panel {
          display: flex;
          height: 100%;
          min-height: 0;
          flex-direction: column;
          background: var(--bg);
        }
        .system-prompt-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 18px 24px 28px;
        }
        .system-prompt-text {
          color: var(--text-muted);
          font-family: var(--font-mono);
          font-size: 12px;
          line-height: 1.6;
          overflow-wrap: anywhere;
          white-space: pre-wrap;
        }
        .system-prompt-empty {
          padding: 10px 0;
          color: var(--text-muted);
          font-size: 12px;
          font-style: italic;
        }
      `}</style>
    </section>
  );
}
