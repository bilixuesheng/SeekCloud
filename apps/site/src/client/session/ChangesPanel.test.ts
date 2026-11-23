import { describe, expect, it } from "vitest";
import { patchLines } from "./ChangesPanel";

describe("改动面板的 diff", () => {
  it("去掉 diff --git、index、---、+++ 这些，按 @@ 记下旧、新文件的行号", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,4 @@ export function a() {",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 3;",
      "+const z = 4;",
      " return x;",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(patchLines(patch)).toEqual([
      { kind: "hunk", text: "@@ -10,3 +10,4 @@ export function a() {" },
      { kind: "ctx", text: "const x = 1;", old: 10, new: 10 },
      { kind: "del", text: "const y = 2;", old: 11 },
      { kind: "add", text: "const y = 3;", new: 11 },
      { kind: "add", text: "const z = 4;", new: 12 },
      { kind: "ctx", text: "return x;", old: 12, new: 13 },
      { kind: "note", text: "文件末尾无换行" },
    ]);
  });

  it("新文件、删掉的文件；只改了权限的没有内容", () => {
    expect(
      patchLines(
        "diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+新的\n",
      ),
    ).toEqual([
      { kind: "hunk", text: "@@ -0,0 +1 @@" },
      { kind: "add", text: "新的", new: 1 },
    ]);
    expect(patchLines("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n")).toEqual([]);
  });
});
