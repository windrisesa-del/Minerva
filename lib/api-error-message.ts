type ApiErrorItem = {
  loc?: unknown;
  msg?: unknown;
};

function formatValidationItem(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const item = value as ApiErrorItem;
  if (typeof item.msg !== "string" || !item.msg.trim()) return null;
  const location = Array.isArray(item.loc)
    ? item.loc.filter((part) => part !== "body").map(String).join(".")
    : "";
  return location ? `${location}：${item.msg}` : item.msg;
}

export function apiErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (Array.isArray(payload)) {
    const messages = payload
      .map((item) => formatValidationItem(item) ?? apiErrorMessage(item, ""))
      .filter(Boolean);
    return messages.join("；") || fallback;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (record.error !== undefined) return apiErrorMessage(record.error, fallback);
    if (record.detail !== undefined) return apiErrorMessage(record.detail, fallback);
    const validationMessage = formatValidationItem(record);
    if (validationMessage) return validationMessage;
  }
  return fallback;
}
