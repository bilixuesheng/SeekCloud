package cn.seekcloud.app.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 改动面板的 diff（#182，照网页的 patchLines）。 */
class SessionDiffTest {
    @Test
    fun linesCarryOldAndNewNumbers() {
        val patch = listOf(
            "diff --git a/src/a.ts b/src/a.ts",
            "index 1111111..2222222 100644",
            "--- a/src/a.ts",
            "+++ b/src/a.ts",
            "@@ -3,3 +3,4 @@ export function a() {",
            " keep",
            "-old",
            "+new",
            "+added",
            " tail",
            "\\ No newline at end of file",
        ).joinToString("\n")
        val lines = patchLines(patch)
        assertEquals(
            listOf(
                PatchLine(PatchLine.Kind.Hunk, "@@ -3,3 +3,4 @@ export function a() {"),
                PatchLine(PatchLine.Kind.Ctx, "keep", old = 3, new = 3),
                PatchLine(PatchLine.Kind.Del, "old", old = 4),
                PatchLine(PatchLine.Kind.Add, "new", new = 4),
                PatchLine(PatchLine.Kind.Add, "added", new = 5),
                PatchLine(PatchLine.Kind.Ctx, "tail", old = 5, new = 6),
                PatchLine(PatchLine.Kind.NoNewline, ""),
            ),
            lines,
        )
    }

    @Test
    fun headerOnlyPatchHasNoLines() {
        // 只改了权限或名称：没有 @@ 段
        assertTrue(patchLines("diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y").isEmpty())
    }
}
