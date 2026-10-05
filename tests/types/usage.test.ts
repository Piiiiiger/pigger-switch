import { describe, expect, it } from "vitest";
import { getCacheWriteAvailability } from "@/types/usage";
import { previousUsageRange, resolveUsageRange } from "@/lib/usageRange";
import { projectBaseName, shortenHome } from "@/components/usage/project";
import { toCsv } from "@/components/usage/exportCsv";

describe("getCacheWriteAvailability", () => {
  it("distinguishes cache-write support across Claude and Codex", () => {
    expect(getCacheWriteAvailability(["claude"])).toBe("ok");
    expect(getCacheWriteAvailability(["codex"])).toBe("na");
    expect(getCacheWriteAvailability(["claude", "codex"])).toBe("partial");
    expect(getCacheWriteAvailability([])).toBe("ok");
  });
});

describe("previousUsageRange", () => {
  const now = new Date(2026, 9, 5, 15, 30, 0).getTime();

  it("compares today with the same hours yesterday", () => {
    const prev = previousUsageRange({ preset: "today" }, now)!;
    const current = resolveUsageRange({ preset: "today" }, now);
    expect(prev.customStartDate).toBe(current.startDate - 86_400);
    expect(prev.customEndDate).toBe(current.endDate - 86_400);
  });

  it("uses the window right before for fixed lookbacks", () => {
    const current = resolveUsageRange({ preset: "7d" }, now);
    const prev = previousUsageRange({ preset: "7d" }, now)!;
    expect(prev.customEndDate).toBe(current.startDate - 1);
    expect(prev.customStartDate).toBe(
      current.startDate - (current.endDate - current.startDate),
    );
  });

  it("has no previous period for all time", () => {
    expect(previousUsageRange({ preset: "all" }, now)).toBeNull();
  });
});

describe("project helpers", () => {
  it("uses the last path segment as the project name", () => {
    expect(projectBaseName("/home/me/code/pigger-switch")).toBe(
      "pigger-switch",
    );
    expect(projectBaseName("C:\\Users\\me\\repo\\")).toBe("repo");
  });

  it("abbreviates home directories", () => {
    expect(shortenHome("/home/me/code/app")).toBe("~/code/app");
    expect(shortenHome("/Users/me/app")).toBe("~/app");
    expect(shortenHome("C:\\Users\\me\\app")).toBe("~\\app");
  });
});

describe("toCsv", () => {
  it("escapes commas, quotes and newlines and adds a BOM", () => {
    const csv = toCsv(["a", "b"], [["x,y", 'say "hi"'], ["line\nbreak", null]]);
    expect(csv).toBe(
      '\uFEFFa,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n',
    );
  });
});
