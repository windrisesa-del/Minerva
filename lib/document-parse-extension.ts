import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { validateNormalizedDocument } from "./minerva-adapter-schema";

const DEFAULT_DATA_API = "http://127.0.0.1:8000";

function dataApiUrl() {
  return (process.env.MINERVA_DATA_API_URL || DEFAULT_DATA_API).replace(/\/$/, "");
}

export function createDocumentParseExtension(): InlineExtension {
  return {
    name: "pi-web-minerva-document-parse",
    hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: "document_parse",
        label: "Parse document",
        description: "Parse one uploaded DOCX, PDF, TXT, PNG, JPG, or JPEG into normalized JSON blocks and visual assets.",
        promptSnippet: "Parse assessment documents deterministically",
        promptGuidelines: [
          "Use document_parse instead of manually extracting or cropping uploaded documents.",
          "Keep visual regions as assets and retain source page and bbox references.",
        ],
        parameters: Type.Object({
          path: Type.String({ description: "An uploaded /uploads/... storage path from the adapter request" }),
        }),
        async execute(_toolCallId, params) {
          try {
            const response = await fetch(`${dataApiUrl()}/api/document/parse`, {
              method: "POST",
              cache: "no-store",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ path: params.path }),
            });
            const payload = await response.json().catch(() => ({ detail: "document_parse returned invalid JSON" }));
            if (!response.ok) {
              const message = typeof payload.detail === "string" ? payload.detail : `document_parse failed with HTTP ${response.status}`;
              return { content: [{ type: "text" as const, text: message }], details: payload, isError: true };
            }
            const document = validateNormalizedDocument(payload);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(document) }],
              details: document,
              isError: false,
            };
          } catch (error) {
            return {
              content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
              details: undefined,
              isError: true,
            };
          }
        },
      }));
    },
  };
}
