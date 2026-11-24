package cn.seekcloud.app.sessions

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 回复里的链接、图片和代码高亮的规矩（#182，照网页的 Markdown.tsx）。 */
class MarkdownRulesTest {
    @Test
    fun onlyGitHubAndTheServerItselfLoadImagesDirectly() {
        assertTrue(trustedImageHost("https://raw.githubusercontent.com/octo/app/main/logo.png", null))
        assertTrue(trustedImageHost("https://github.com/octo/app/blob/main/a.png?raw=true", null))
        assertTrue(trustedImageHost("https://user-images.githubusercontent.com/1/2.png", null))
        assertTrue(trustedImageHost("https://seekcloud.example.com/brand/whale.webp", "SeekCloud.example.com"))
        // 别的来源点了才加载；假冒的域名不算
        assertFalse(trustedImageHost("https://evil.example/leak?key=abc", "seekcloud.example.com"))
        assertFalse(trustedImageHost("https://githubusercontent.com.evil.example/a.png", null))
        assertFalse(trustedImageHost("https://evilgithub.com/a.png", null))
        // 不是网址的不加载
        assertFalse(trustedImageHost("file:///etc/passwd", null))
        assertFalse(trustedImageHost("data:image/png;base64,AAAA", null))
        assertEquals("evil.example", imageHost("https://evil.example/leak"))
    }

    @Test
    fun onlyWebAndMailLinksOpen() {
        assertTrue(isOpenableLink("https://example.com"))
        assertTrue(isOpenableLink("HTTP://example.com"))
        assertTrue(isOpenableLink("mailto:a@example.com"))
        assertFalse(isOpenableLink("javascript:alert(1)"))
        assertFalse(isOpenableLink("intent://scan#Intent;end"))
        assertFalse(isOpenableLink("file:///sdcard/a"))
        assertFalse(isOpenableLink("src/app.ts"))
    }

    @Test
    fun pullRequestAndIssueLinksBecomeShortNumbers() {
        val ref = githubRef("https://github.com/octo/app/pull/42")
        assertEquals(GitHubRef("octo/app", pull = true, number = 42), ref)
        assertEquals(GitHubRef("octo/app", pull = false, number = 7), githubRef("https://github.com/octo/app/issues/7#issuecomment-1"))
        assertNull(githubRef("https://github.com/octo/app/blob/main/README.md"))
        assertNull(githubRef("http://github.com/octo/app/pull/42"))
        ref!!
        assertTrue(plainLabel("https://github.com/octo/app/pull/42", "https://github.com/octo/app/pull/42", ref))
        assertTrue(plainLabel("#42", "https://github.com/octo/app/pull/42", ref))
        assertTrue(plainLabel("octo/app#42", "https://github.com/octo/app/pull/42", ref))
        // 链接文字是别的话：照原样显示
        assertFalse(plainLabel("修复登录的 PR", "https://github.com/octo/app/pull/42", ref))
        assertEquals("#42", githubLabel(ref, "Octo/App"))
        assertEquals("octo/app#42", githubLabel(ref, "octo/lib"))
        assertEquals("octo/app#42", githubLabel(ref, null))
    }

    private fun kinds(code: String, lang: String) = highlightCode(code, lang).map { code.substring(it.start, it.end) to it.kind }

    @Test
    fun highlightsCommentsStringsNumbersAndKeywords() {
        assertEquals(
            listOf(
                "const" to CodeKind.Keyword,
                "\"a // b\"" to CodeKind.Str,
                "42" to CodeKind.Number,
                "// 注释" to CodeKind.Comment,
            ),
            kinds("const x = \"a // b\" + 42 // 注释", "ts"),
        )
        assertEquals(
            listOf("# 安装" to CodeKind.Comment, "echo" to CodeKind.Keyword, "'hi'" to CodeKind.Str),
            kinds("# 安装\necho 'hi'", "bash"),
        )
        assertEquals(listOf("def" to CodeKind.Keyword, "\"\"\"doc\nmore\"\"\"" to CodeKind.Str), kinds("def f():\n  \"\"\"doc\nmore\"\"\"", "python"))
        assertEquals(listOf("SELECT" to CodeKind.Keyword, "FROM" to CodeKind.Keyword, "-- all" to CodeKind.Comment), kinds("SELECT * FROM t -- all", "sql"))
        // 变量名里的数字不算数字；没有收尾的引号到行末为止
        assertEquals(listOf("\"open" to CodeKind.Str), kinds("v2 = \"open\nnext", "text"))
        // 纯文本不认关键字
        assertTrue(highlightCode("if this then that", "text").isEmpty())
    }

    @Test
    fun tokenOnlyGoesToTheServerOrigin() {
        val server = "https://seekcloud.example.com/".toHttpUrl()
        assertTrue(sameOrigin("https://seekcloud.example.com/brand/a.png".toHttpUrl(), server))
        assertFalse(sameOrigin("http://seekcloud.example.com/brand/a.png".toHttpUrl(), server))
        assertFalse(sameOrigin("https://seekcloud.example.com:8443/a.png".toHttpUrl(), server))
        assertFalse(sameOrigin("https://cdn.seekcloud.example.com/a.png".toHttpUrl(), server))
    }
}
