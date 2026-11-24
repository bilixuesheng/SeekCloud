package cn.seekcloud.app.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 回复逐字显示（#182），和网页的 paced-text.test.ts 同一套情形。 */
class PacedTextTest {
    /** 按 [by] 一步步往后显示，记下每次停在哪。 */
    private fun stops(text: String, by: Int): List<String> {
        val blocked = cutMap(text)
        val out = mutableListOf<String>()
        var at = 0
        while (at < text.length) {
            at = nextCut(blocked, at, at + by)
            out += text.substring(0, at)
        }
        return out
    }

    @Test
    fun chineseComesOneCharacterAtATime() {
        assertEquals(listOf("先", "先看", "先看代", "先看代码"), stops("先看代码", 1))
    }

    @Test
    fun boldInlineCodeAndWordsAreNotCut() {
        val shown = stops("看 **重点** 和 `src/app.ts` 里的 build", 1)
        for (s in shown) {
            assertEquals(0, Regex("""\*\*""").findAll(s).count() % 2)
            assertEquals(0, s.count { it == '`' } % 2)
        }
        assertTrue("看 **重点**" in shown)
        assertFalse("看 **重点** 和 `src/app.ts` 里的 bu" in shown)
    }

    @Test
    fun headingsComeWithTheFirstCharacterAndTablesWhole() {
        val shown = stops("## 改了\n| 步骤 | 结果 |\n|---|---|\n| 看 | 完 |\n后面", 1)
        assertFalse("#" in shown)
        assertFalse("## " in shown)
        assertTrue("## 改" in shown)
        assertFalse(shown.any { "|" in it && "| 看 | 完 |" !in it })
        assertTrue("## 改了\n| 步骤 | 结果 |\n|---|---|\n| 看 | 完 |" in shown)
    }

    @Test
    fun aboutAHundredPerSecondAndCatchesUpInTwoAndAHalfSeconds() {
        assertEquals(5, pacedStep(10))
        assertEquals(20, pacedStep(1000))
        assertEquals(5, pacedStep(0))
    }

    @Test
    fun codeBlocksComeALineAtATime() {
        val shown = stops("看：\n```ts\nconst a = 1;\nlet b = 2;\n```\n完", 1)
        assertFalse(shown.any { it.endsWith("const a = ") })
        assertTrue("看：\n```ts\nconst a = 1;\n" in shown)
    }
}
