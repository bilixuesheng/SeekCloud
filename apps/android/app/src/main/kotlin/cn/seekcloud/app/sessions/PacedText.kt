package cn.seekcloud.app.sessions

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Agent 的回复按舒服的速度一个个字显示出来（#182，规则照网页的 paced-text.ts）：不管是一整条到的，
 * 还是逐字输出一段段推来的，显示的速度都由这里决定。平时每秒约 [BASE_CPS] 个字；积压多了就加快，
 * 保证 [CATCH_UP_S] 秒内追上。Markdown 的标记不截在半截：加粗、行内代码、链接、英文单词、代码块的围栏行、
 * 行首的标题号和列表符号都整体出现；代码块里一整行一起出；表格整张出来。
 */
const val PACED_TICK_MS = 50L
private const val BASE_CPS = 100.0
private const val CATCH_UP_S = 2.5

/** 每个位置能不能截断：结果的第 i 个为真表示不能停在第 i 个字之前（0 和末尾总能停）。 */
fun cutMap(text: String): BooleanArray {
    val blocked = BooleanArray(text.length + 1)
    fun block(from: Int, to: Int) {
        for (i in from + 1 until min(to, text.length)) blocked[i] = true
    }
    fun each(re: Regex, fn: (Int, Int) -> Unit) {
        for (m in re.findAll(text)) fn(m.range.first, m.range.last + 1)
    }
    each(Regex("""\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]*]\([^)\n]*\)""")) { s, e -> block(s, e) }
    each(Regex("""[A-Za-z0-9_][A-Za-z0-9_.\-/]*""")) { s, e -> block(s, e) }
    each(Regex("""^[ \t]*```.*$""", RegexOption.MULTILINE)) { s, e -> block(s, e) }
    var fenced = false
    var at = 0
    for (line in text.split("\n")) {
        val end = at + line.length
        if (Regex("""^[ \t]*```""").containsMatchIn(line)) fenced = !fenced else if (fenced) block(at, end + 1)
        at = end + 1
    }
    each(Regex("""(?:^[ \t]*\|.*(?:\n|$))+""", RegexOption.MULTILINE)) { s, e ->
        block(s, if (e > 0 && text[e - 1] == '\n') e - 1 else e)
    }
    each(Regex("""^[ \t]*(#{1,6}[ \t]+|[-*+][ \t]+|\d+\.[ \t]+|>[ \t]?)""", RegexOption.MULTILINE)) { s, e -> block(s, e + 1) }
    return blocked
}

/** 从 [from] 往后显示到大约 [want]：不超过 want 的最后一个能停的位置；中间一个都没有时，往后找第一个。 */
fun nextCut(blocked: BooleanArray, from: Int, want: Int): Int {
    val end = blocked.size - 1
    val target = min(max(want, from + 1), end)
    for (i in target downTo from + 1) if (!blocked[i]) return i
    for (i in target + 1..end) if (!blocked[i]) return i
    return end
}

/** 这一下显示多少个字：平时按 [BASE_CPS]，积压多了按 [CATCH_UP_S] 秒追上的速度。 */
fun pacedStep(backlog: Int, ms: Long = PACED_TICK_MS): Int =
    max(1, (max(BASE_CPS, backlog / CATCH_UP_S) * ms / 1000).roundToInt())
