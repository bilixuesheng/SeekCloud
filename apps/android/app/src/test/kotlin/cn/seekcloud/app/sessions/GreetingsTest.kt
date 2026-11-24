package cn.seekcloud.app.sessions

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 问候语（#124）：规则照网页的 greetings.ts；生成的两份句子读得出来；等你输入的会话怎么挑。 */
class GreetingsTest {
    private val set = GreetingSet(
        seek = "seek",
        always = listOf("a1", "a2"),
        alwaysNamed = listOf("hi {name}"),
        byHour = listOf(
            GreetingSet.HourGreetings(5, 11, listOf("morning"), listOf("morning {name}")),
            // 跨零点：23 点到第二天 5 点
            GreetingSet.HourGreetings(23, 29, listOf("night"), emptyList()),
        ),
        byDay = List(7) { day -> if (day == 0) listOf("sunday") to emptyList() else emptyList<String>() to emptyList() },
    )

    @Test
    fun poolDependsOnTimeDayAndName() {
        assertEquals(listOf("a1", "a2", "morning"), greetingPool(set, null, hour = 8, dayOfWeek = 3))
        assertEquals(listOf("a1", "a2", "night"), greetingPool(set, "", hour = 2, dayOfWeek = 3))
        assertEquals(listOf("a1", "a2", "night"), greetingPool(set, null, hour = 23, dayOfWeek = 3))
        assertEquals(listOf("a1", "a2", "sunday"), greetingPool(set, null, hour = 14, dayOfWeek = 0))
        assertEquals(
            listOf("a1", "a2", "morning", "hi 小明", "morning 小明"),
            greetingPool(set, " 小明 ", hour = 8, dayOfWeek = 3),
        )
    }

    @Test
    fun seekHasAFifthAndTheRestIsSharedEvenly() {
        assertEquals("seek", pickGreeting(set, null, 14, 3, random = 0.0))
        assertEquals("seek", pickGreeting(set, null, 14, 3, random = 0.199))
        assertEquals("a1", pickGreeting(set, null, 14, 3, random = 0.2))
        assertEquals("a2", pickGreeting(set, null, 14, 3, random = 0.999))
    }

    @Test
    fun generatedGreetingsParse() {
        for (path in listOf("src/main/res/raw/greetings.json", "src/main/res/raw-zh/greetings.json")) {
            val parsed = GreetingSet.parse(File(path).readText())
            assertTrue(path, parsed.seek.isNotBlank() && parsed.always.isNotEmpty())
            assertEquals(path, 7, parsed.byDay.size)
            // 每个时段、每个星期几都挑得出句子
            for (hour in 0 until 24) for (day in 0 until 7) {
                assertTrue(pickGreeting(parsed, "Ada", hour, day, random = 0.5).isNotBlank())
            }
        }
    }

    @Test
    fun awaitingInputIsNotArchivedAndNewestFirst() {
        fun s(id: String, status: String, detail: String?, updatedAt: String) =
            SessionSummary(id, id, status, detail, createdAt = "t", updatedAt = updatedAt)
        val list = listOf(
            s("a", "waiting", "awaiting_input", "2026-01-01T00:00:00Z"),
            s("b", "dormant", "awaiting_input", "2026-01-03T00:00:00Z"),
            s("c", "archived", "awaiting_input", "2026-01-04T00:00:00Z"),
            s("d", "waiting", "done", "2026-01-05T00:00:00Z"),
        )
        assertEquals(listOf("b", "a"), awaitingInput(list).map { it.shortId })
    }
}
