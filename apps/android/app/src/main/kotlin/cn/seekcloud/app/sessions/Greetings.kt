package cn.seekcloud.app.sessions

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * 新会话页的问候语（#124），句子和规则照网页（client/session/greetings.ts）：每次打开随机挑一句；
 * 有的看时间、看星期几，只在对应的时候出现；设置过昵称时，一部分带上昵称。
 * 句子由主站的文案目录生成（res/raw/greetings.json，中文在 raw-zh），App 按系统语言读。
 * 网页上"你是某地人吗"那一句要按浏览器的语言猜地区，App 里不用。
 */
data class GreetingSet(
    val seek: String,
    val always: List<String>,
    val alwaysNamed: List<String>,
    /** 一天里的几个时段：开始的小时、结束的小时（不含，跨零点的写到 24 以上）、不带昵称的、带昵称的。 */
    val byHour: List<HourGreetings>,
    /** 星期几（0 是周日）：不带昵称的、带昵称的。 */
    val byDay: List<Pair<List<String>, List<String>>>,
) {
    data class HourGreetings(val from: Int, val to: Int, val plain: List<String>, val named: List<String>)

    companion object {
        fun parse(json: String): GreetingSet {
            val root = Json.parseToJsonElement(json).jsonObject
            fun strings(element: JsonElement) = element.jsonArray.map { it.jsonPrimitive.content }
            return GreetingSet(
                seek = root.getValue("seek").jsonPrimitive.content,
                always = strings(root.getValue("always")),
                alwaysNamed = strings(root.getValue("alwaysNamed")),
                byHour = root.getValue("byHour").jsonArray.map { entry ->
                    val e = entry.jsonArray
                    HourGreetings(e[0].jsonPrimitive.int, e[1].jsonPrimitive.int, strings(e[2]), strings(e[3]))
                },
                byDay = root.getValue("byDay").jsonArray.map { entry ->
                    val e = entry.jsonArray
                    strings(e[0]) to strings(e[1])
                },
            )
        }
    }
}

/** 单独调高的一句（seek）占的机会（2026-11-16 用户定的）。 */
private const val BOOST = 0.2

/** 此刻能用的句子（不含 seek），每句机会一样。昵称为空时只有不带昵称的。[dayOfWeek] 0 是周日。 */
fun greetingPool(set: GreetingSet, name: String?, hour: Int, dayOfWeek: Int): List<String> {
    val plain = set.always.toMutableList()
    val named = set.alwaysNamed.toMutableList()
    for (h in set.byHour) {
        // 夜里的时段跨过零点：23 点到第二天 5 点
        if ((hour >= h.from && hour < h.to) || (h.to > 24 && hour < h.to - 24)) {
            plain += h.plain
            named += h.named
        }
    }
    set.byDay.getOrNull(dayOfWeek)?.let { (p, n) ->
        plain += p
        named += n
    }
    val who = name?.trim().orEmpty()
    if (who.isEmpty()) return plain
    return plain + named.map { it.replace("{name}", who) }
}

/** 挑一句：BOOST 的机会是 seek，剩下的在 [greetingPool] 里平均分。[random] 在 0 到 1 之间。 */
fun pickGreeting(set: GreetingSet, name: String?, hour: Int, dayOfWeek: Int, random: Double): String {
    if (random < BOOST) return set.seek
    val pool = greetingPool(set, name, hour, dayOfWeek)
    if (pool.isEmpty()) return set.seek
    val index = (((random - BOOST) / (1 - BOOST)) * pool.size).toInt()
    return pool[index.coerceIn(pool.indices)]
}

/** 在等你输入的会话（#139）：已归档的不算，最近的在前（照网页的 AwaitingInputHint）。 */
fun awaitingInput(sessions: List<SessionSummary>): List<SessionSummary> =
    sessions.filter { it.detail == "awaiting_input" && it.status != "archived" }.sortedByDescending { it.updatedAt }
