import assert from "node:assert/strict";
import test from "node:test";
import { apiErrorMessage } from "./api-error-message.ts";

test("formats FastAPI validation detail instead of object coercion", () => {
  assert.equal(
    apiErrorMessage({ detail: [{ loc: ["body", "files", 0], msg: "Field required", type: "missing" }] }, "导入失败"),
    "files.0：Field required",
  );
});

test("keeps ordinary API errors and fallbacks readable", () => {
  assert.equal(apiErrorMessage({ error: "服务不可用" }, "导入失败"), "服务不可用");
  assert.equal(apiErrorMessage({}, "导入失败"), "导入失败");
});
