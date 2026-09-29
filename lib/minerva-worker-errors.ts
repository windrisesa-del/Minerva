export type ModelWorkerEvent = {
  type?: string;
  errorMessage?: string;
  message?: { role?: string; stopReason?: string; errorMessage?: string };
};

/** Track the last model outcome, not transient errors already healed by SDK retry. */
export function nextModelFailure(current: string | null, event: ModelWorkerEvent): string | null {
  if (event.type === "prompt_error") return event.errorMessage || "LLM 连接中断";
  if (event.type !== "message_end" || event.message?.role !== "assistant") return current;
  if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
    return event.message.errorMessage || "模型请求未完成";
  }
  if (event.message.stopReason === "stop" || event.message.stopReason === "toolUse") return null;
  return current;
}

export function isModelConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:Connection error\.?|terminated|LLM 连接中断)$|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(message);
}
