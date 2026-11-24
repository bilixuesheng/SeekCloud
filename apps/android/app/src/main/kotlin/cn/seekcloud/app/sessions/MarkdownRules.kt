package cn.seekcloud.app.sessions

import java.net.URI

/** 能交给浏览器打开的地址：只有 http、https 和 mailto（照网页的 Markdown.tsx）。 */
fun isOpenableLink(href: String): Boolean = Regex("^(https?:|mailto:)", RegexOption.IGNORE_CASE).containsMatchIn(href)

fun isWebUrl(url: String): Boolean = Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(url)

private fun hostOf(url: String): String? = runCatching { URI(url).host?.lowercase() }.getOrNull()

/**
 * 这些来源的图片直接显示（照网页的 trustedImageHost）：GitHub 的和主站自己的。别的来源要点一下才加载：
 * 图片地址是 Agent 写的，Agent 读到的外部内容可以诱导它把仓库里的密钥拼进图片地址，一加载就送到了别人的服务器上。
 */
fun trustedImageHost(src: String, serverHost: String?): Boolean {
    if (!isWebUrl(src)) return false
    val host = hostOf(src) ?: return false
    if (serverHost != null && host == serverHost.lowercase()) return true
    return host == "github.com" || host == "github.githubassets.com" || host.endsWith(".githubusercontent.com")
}

/** 图片的来源主机名（"点击加载"的说明里写它）。 */
fun imageHost(src: String): String? = hostOf(src)

/** GitHub 上 PR 或 issue 的地址，比如 https://github.com/octo/app/pull/42。 */
data class GitHubRef(val repo: String, val pull: Boolean, val number: Int)

fun githubRef(href: String): GitHubRef? {
    val m = Regex("""^https://github\.com/([\w.-]+/[\w.-]+)/(pull|issues)/(\d+)(?:[/?#].*)?$""", RegexOption.IGNORE_CASE)
        .find(href) ?: return null
    return GitHubRef(m.groupValues[1], m.groupValues[2].equals("pull", ignoreCase = true), m.groupValues[3].toInt())
}

/** 链接文字就是地址本身，或者只是"#42"这类编号：这样的链接写成短的编号不会丢掉信息（照网页的 plainLabel）。 */
fun plainLabel(text: String, href: String, ref: GitHubRef): Boolean =
    text == href || Regex("""^(?:[\w.-]+/[\w.-]+)?#${ref.number}$""").matches(text.trim())

/** PR、issue 链接显示成的短编号：会话主仓库里的只写 #42，别的仓库写 octo/lib#42。 */
fun githubLabel(ref: GitHubRef, sessionRepo: String?): String =
    (if (sessionRepo != null && sessionRepo.equals(ref.repo, ignoreCase = true)) "" else ref.repo) + "#${ref.number}"

/** 代码高亮的一段：[start] 到 [end]（不含）是哪一类。 */
data class CodeSpan(val start: Int, val end: Int, val kind: CodeKind)

enum class CodeKind { Keyword, Str, Comment, Number }

private val HASH_COMMENT = setOf(
    "python", "py", "sh", "bash", "shell", "zsh", "console", "yaml", "yml", "toml", "ruby", "rb", "r",
    "dockerfile", "docker", "makefile", "make", "perl", "pl", "ini", "conf", "properties", "nginx", "powershell", "ps1",
)
private val DASH_COMMENT = setOf("sql", "lua", "haskell", "hs")

private val PYTHON = setOf(
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
    "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or",
    "pass", "raise", "return", "try", "while", "with", "yield", "self",
)
private val SHELL = setOf(
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function",
    "return", "export", "local", "readonly", "set", "unset", "echo", "exit",
)
private val SQL = setOf(
    "select", "from", "where", "and", "or", "not", "insert", "into", "values", "update", "set", "delete", "create",
    "table", "drop", "alter", "add", "index", "primary", "key", "references", "join", "left", "right", "inner", "on",
    "group", "by", "order", "limit", "as", "null", "is", "default", "unique", "foreign",
)
private val JSON_WORDS = setOf("true", "false", "null")

/** C 系、JS/TS、Kotlin、Java、Go、Rust、Swift 这类常见语言的关键字合在一起（不知道是什么语言时也用它）。 */
private val C_LIKE = setOf(
    "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "data", "def", "default",
    "defer", "delete", "do", "else", "enum", "export", "extends", "false", "final", "finally", "fn", "for", "from", "fun",
    "func", "function", "go", "if", "impl", "implements", "import", "in", "instanceof", "interface", "internal", "is", "let",
    "match", "mod", "mut", "new", "nil", "null", "object", "open", "override", "package", "private", "protected", "pub",
    "public", "return", "self", "static", "struct", "super", "suspend", "switch", "this", "throw", "throws", "trait",
    "true", "try", "type", "typeof", "undefined", "use", "val", "var", "void", "when", "where", "while", "yield",
)

/**
 * 很简单的代码高亮：注释、字符串、数字、关键字四类，按代码块写的语言挑注释的写法和关键字。
 * 不求准确，求不出错：认不出的照原样显示。
 */
fun highlightCode(code: String, language: String): List<CodeSpan> {
    val lang = language.trim().lowercase().substringBefore(' ')
    val hash = lang in HASH_COMMENT
    val dash = lang in DASH_COMMENT
    val keywords = when {
        lang in setOf("python", "py") -> PYTHON
        lang in setOf("sh", "bash", "shell", "zsh", "console") -> SHELL
        lang == "sql" -> SQL
        lang == "json" || lang == "jsonc" -> JSON_WORDS
        lang in setOf("text", "txt", "plain", "markdown", "md", "diff") -> emptySet()
        else -> C_LIKE
    }
    val caseInsensitive = lang == "sql"
    val slashComments = !hash && !dash && lang !in setOf("text", "txt", "plain", "markdown", "md")
    val spans = mutableListOf<CodeSpan>()
    var i = 0
    val n = code.length
    fun isIdent(c: Char) = c.isLetterOrDigit() || c == '_' || c == '$'
    while (i < n) {
        val c = code[i]
        when {
            hash && c == '#' -> {
                val end = code.indexOf('\n', i).let { if (it < 0) n else it }
                spans += CodeSpan(i, end, CodeKind.Comment)
                i = end
            }
            dash && c == '-' && code.startsWith("--", i) -> {
                val end = code.indexOf('\n', i).let { if (it < 0) n else it }
                spans += CodeSpan(i, end, CodeKind.Comment)
                i = end
            }
            slashComments && code.startsWith("//", i) -> {
                val end = code.indexOf('\n', i).let { if (it < 0) n else it }
                spans += CodeSpan(i, end, CodeKind.Comment)
                i = end
            }
            slashComments && code.startsWith("/*", i) -> {
                val end = code.indexOf("*/", i + 2).let { if (it < 0) n else it + 2 }
                spans += CodeSpan(i, end, CodeKind.Comment)
                i = end
            }
            c == '"' || c == '\'' || c == '`' -> {
                val triple = (c == '"' || c == '\'') && code.startsWith("$c$c$c", i)
                val end = if (triple) {
                    code.indexOf("$c$c$c", i + 3).let { if (it < 0) n else it + 3 }
                } else {
                    var j = i + 1
                    while (j < n && code[j] != c && (c == '`' || code[j] != '\n')) j += if (code[j] == '\\') 2 else 1
                    // 没有收尾的引号：到这一行末尾为止
                    if (j < n && code[j] == c) j + 1 else minOf(j, n)
                }
                spans += CodeSpan(i, end, CodeKind.Str)
                i = end
            }
            c.isDigit() && (i == 0 || !isIdent(code[i - 1])) -> {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '.' || code[j] == '_')) j++
                spans += CodeSpan(i, j, CodeKind.Number)
                i = j
            }
            isIdent(c) -> {
                var j = i + 1
                while (j < n && isIdent(code[j])) j++
                val word = code.substring(i, j)
                if ((if (caseInsensitive) word.lowercase() else word) in keywords) spans += CodeSpan(i, j, CodeKind.Keyword)
                i = j
            }
            else -> i++
        }
    }
    return spans
}
