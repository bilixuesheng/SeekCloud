package cn.seekcloud.app

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/**
 * 令牌不进日志、不进备份（#205 的验收标准）：读 App 的源码和清单核对。
 * Gradle 跑单元测试时的工作目录是 app/。
 */
class PrivacyChecksTest {
    private val main = File("src/main")

    /** App 自己的代码里不打日志：没有 Log、println、printStackTrace，也不用 OkHttp 的日志拦截器。 */
    @Test
    fun appCodeDoesNotLog() {
        val banned = listOf(
            Regex("""\bandroid\.util\.Log\b"""),
            Regex("""\bLog\.[vdiwe]\("""),
            Regex("""\bprintln\("""),
            Regex("""\.printStackTrace\("""),
            Regex("""HttpLoggingInterceptor"""),
        )
        val sources = File(main, "kotlin").walkTopDown().filter { it.extension == "kt" }.toList()
        assertTrue(sources.size > 10)
        val found = sources.flatMap { file ->
            file.readLines().mapIndexedNotNull { i, line ->
                banned.firstOrNull { it.containsMatchIn(line) }?.let { "${file.path}:${i + 1}: ${line.trim()}" }
            }
        }
        assertEquals(emptyList<String>(), found)
    }

    @Test
    fun backupIsOff() {
        val manifest = xml(File(main, "AndroidManifest.xml"))
        val app = manifest.getElementsByTagName("application").item(0) as Element
        assertEquals("false", app.getAttribute("android:allowBackup"))
        assertEquals("@xml/data_extraction_rules", app.getAttribute("android:dataExtractionRules"))
        assertEquals("@xml/backup_rules", app.getAttribute("android:fullBackupContent"))
    }

    /** 安卓 12 以上的云备份和换机迁移、安卓 11 以下的备份，每一块存储都排除了。 */
    @Test
    fun everyStorageDomainIsExcludedFromBackupAndTransfer() {
        val domains = setOf("root", "file", "database", "sharedpref", "external")
        val rules = xml(File(main, "res/xml/data_extraction_rules.xml"))
        for (section in listOf("cloud-backup", "device-transfer")) {
            val element = rules.getElementsByTagName(section).item(0) as Element
            assertEquals(section, domains, excluded(element))
            assertEquals(section, 0, element.getElementsByTagName("include").length)
        }
        val legacy = xml(File(main, "res/xml/backup_rules.xml")).documentElement
        assertEquals(domains, excluded(legacy))
        assertEquals(0, legacy.getElementsByTagName("include").length)
    }

    private fun excluded(element: Element): Set<String> {
        val nodes = element.getElementsByTagName("exclude")
        return (0 until nodes.length).map { (nodes.item(it) as Element).getAttribute("domain") }.toSet()
    }

    private fun xml(file: File) = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
}
