import { describe, expect, it } from "vitest";
import { extractErrorMessage } from "@/utils/errorUtils";

describe("error utilities", () => {
  it("extracts Tauri string errors", () => {
    expect(extractErrorMessage("backend failed")).toBe("backend failed");
  });

  it("extracts messages from Error objects", () => {
    expect(extractErrorMessage(new Error("boom"))).toBe("boom");
  });
});
