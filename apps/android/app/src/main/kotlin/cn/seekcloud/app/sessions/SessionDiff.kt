package cn.seekcloud.app.sessions

import kotlinx.serialization.Serializable

/** 会话分支对比基础分支的改动（改动面板，#27）：一个仓库一份，回合结束时宿主机算的最新的。 */
@Serializable
data class RepoDiff(
    val fullName: String,
    val baseBranch: String = "",
    val files: List<DiffFile> = emptyList(),
    /** 文件太多、patch 太大，后面的没带内容。 */
    val truncated: Boolean = false,
)

@Serializable
data class DiffFile(
    val path: String,
    val from: String? = null,
    val additions: Int = 0,
    val deletions: Int = 0,
    val binary: Boolean = false,
    val patch: String? = null,
    val tooLarge: Boolean = false,
)

/** 置顶的一条回复（照网页）：[title] 为 null 表示短标题还在生成，空字符串表示取不出标题。 */
@Serializable
data class MessagePin(val seq: Int, val title: String? = null, val createdAt: String = "")

/** diff 的一行：[old]、[new] 是旧文件、新文件里的行号（新增的行没有旧行号，删掉的行没有新行号）。 */
data class PatchLine(val kind: Kind, val text: String, val old: Int? = null, val new: Int? = null) {
    enum class Kind { Hunk, Add, Del, Ctx, NoNewline }
}

/** git diff 的一个文件（照网页的 patchLines）：去掉开头的 diff --git、index、---、+++ 这些，按 @@ 记下行号。 */
fun patchLines(patch: String): List<PatchLine> {
    val lines = mutableListOf<PatchLine>()
    var oldNo = 0
    var newNo = 0
    var inHunk = false
    val hunk = Regex("""^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$""")
    for (raw in patch.split("\n")) {
        val m = hunk.find(raw)
        if (m != null) {
            oldNo = m.groupValues[1].toInt()
            newNo = m.groupValues[2].toInt()
            inHunk = true
            lines += PatchLine(PatchLine.Kind.Hunk, raw)
            continue
        }
        if (!inHunk) continue
        when {
            raw.startsWith("+") -> lines += PatchLine(PatchLine.Kind.Add, raw.substring(1), new = newNo++)
            raw.startsWith("-") -> lines += PatchLine(PatchLine.Kind.Del, raw.substring(1), old = oldNo++)
            raw.startsWith(" ") -> lines += PatchLine(PatchLine.Kind.Ctx, raw.substring(1), old = oldNo++, new = newNo++)
            raw.startsWith("\\") -> lines += PatchLine(PatchLine.Kind.NoNewline, "")
        }
    }
    return lines
}
