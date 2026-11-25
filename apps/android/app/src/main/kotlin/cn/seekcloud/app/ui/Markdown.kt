package cn.seekcloud.app.ui

import android.content.ClipData
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import cn.seekcloud.app.R
import cn.seekcloud.app.sessions.CodeKind
import cn.seekcloud.app.sessions.ImageLoader
import cn.seekcloud.app.sessions.githubLabel
import cn.seekcloud.app.sessions.githubRef
import cn.seekcloud.app.sessions.highlightCode
import cn.seekcloud.app.sessions.imageHost
import cn.seekcloud.app.sessions.isOpenableLink
import cn.seekcloud.app.sessions.isWebUrl
import cn.seekcloud.app.sessions.plainLabel
import cn.seekcloud.app.sessions.trustedImageHost
import kotlinx.coroutines.launch
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableHead
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.task.list.items.TaskListItemMarker
import org.commonmark.ext.task.list.items.TaskListItemsExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image as MdImage
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListBlock
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text as MdText
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

/** 回复里的图片怎么加载、哪些来源直接显示、会话的主仓库（PR、issue 链接写成短编号时用）。 */
data class MarkdownEnv(val images: ImageLoader? = null, val serverHost: String? = null, val repo: String? = null)

val LocalMarkdownEnv = staticCompositionLocalOf { MarkdownEnv() }

/** 点了链接：先确认再交给浏览器。 */
private val LocalOpenLink = staticCompositionLocalOf<(String) -> Unit> { {} }

private val parser: Parser = Parser.builder()
    .extensions(
        listOf(
            TablesExtension.create(),
            StrikethroughExtension.create(),
            TaskListItemsExtension.create(),
            AutolinkExtension.create(),
        ),
    )
    .build()

/**
 * Agent 回复的 Markdown（#182，照网页的 Markdown.tsx）：标题、列表、引用、表格（横着滚）、代码块（高亮、横着滚、复制）、
 * 行内代码、链接（先显示完整的地址确认，再交给浏览器）、图片（只有 GitHub 和主站自己的直接显示，别的点了才加载）。
 * 原始 HTML 不渲染，当文字显示。
 */
@Composable
fun Markdown(text: String, modifier: Modifier = Modifier) {
    val document = remember(text) { parser.parse(text) }
    var confirm by remember { mutableStateOf<String?>(null) }
    CompositionLocalProvider(LocalOpenLink provides { confirm = it }) {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) { Blocks(document) }
    }
    confirm?.let { url ->
        val uri = LocalUriHandler.current
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(stringResource(R.string.link_open_title)) },
            text = {
                Column {
                    Text(stringResource(R.string.link_open_body))
                    Spacer(Modifier.height(8.dp))
                    Text(url, style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    runCatching { uri.openUri(url) }
                }) { Text(stringResource(R.string.link_open_confirm)) }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}

private fun Node.children(): List<Node> = generateSequence(firstChild) { it.next }.toList()

@Composable
private fun Blocks(parent: Node) {
    for (node in parent.children()) Block(node)
}

@Composable
private fun Block(node: Node) {
    val typography = MaterialTheme.typography
    when (node) {
        is Paragraph -> Inlines(node, typography.bodyLarge)
        is Heading -> Inlines(
            node,
            when (node.level) {
                1 -> typography.titleLarge
                2 -> typography.titleMedium
                else -> typography.titleSmall
            }.copy(fontWeight = FontWeight.SemiBold),
        )
        is ListBlock -> ListView(node)
        is BlockQuote -> Row(Modifier.fillMaxWidth()) {
            Box(Modifier.width(3.dp).heightIn(min = 20.dp).background(MaterialTheme.colorScheme.outlineVariant))
            Column(Modifier.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { Blocks(node) }
        }
        is FencedCodeBlock -> CodeView(node.literal.orEmpty(), node.info.orEmpty())
        is IndentedCodeBlock -> CodeView(node.literal.orEmpty(), "")
        is ThematicBreak -> HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        // 原始 HTML 当文字显示
        is HtmlBlock -> Text(node.literal.orEmpty().trimEnd(), style = typography.bodyLarge)
        is TableBlock -> TableView(node)
        else -> Blocks(node)
    }
}

/** 一段文字（段落、标题、表格的格子）：图片单独占一块，别的连成一段。 */
@Composable
private fun Inlines(node: Node, style: TextStyle) {
    val env = LocalMarkdownEnv.current
    val open = LocalOpenLink.current
    val colors = MaterialTheme.colorScheme
    val codeBackground = colors.surfaceVariant
    val linkStyle = TextLinkStyles(SpanStyle(color = colors.primary, textDecoration = TextDecoration.Underline))
    val segments = remember(node, env.repo, codeBackground, linkStyle) {
        val out = mutableListOf<Any>()
        var builder = AnnotatedString.Builder()
        fun flush() {
            if (builder.length > 0) out += builder.toAnnotatedString()
            builder = AnnotatedString.Builder()
        }
        fun walk(n: Node) {
            when (n) {
                is MdText -> builder.append(n.literal)
                is SoftLineBreak -> builder.append(' ')
                is HardLineBreak -> builder.append('\n')
                is HtmlInline -> builder.append(n.literal)
                is Code -> builder.withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBackground)) { append(n.literal) }
                is Emphasis -> builder.withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { n.children().forEach(::walk) }
                is StrongEmphasis -> builder.withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { n.children().forEach(::walk) }
                is Strikethrough -> builder.withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { n.children().forEach(::walk) }
                is TaskListItemMarker -> builder.append(if (n.isChecked) "☑ " else "☐ ")
                is Link -> {
                    val href = n.destination.orEmpty()
                    if (!isOpenableLink(href)) {
                        n.children().forEach(::walk)
                    } else {
                        val link = LinkAnnotation.Clickable(href, linkStyle) { open(href) }
                        val ref = githubRef(href)
                        val label = textOf(n)
                        builder.withLink(link) {
                            // PR、issue 的链接文字就是地址或编号时，写成短编号（网页上是胶囊）
                            if (ref != null && plainLabel(label, href, ref)) append(githubLabel(ref, env.repo)) else n.children().forEach(::walk)
                        }
                    }
                }
                is MdImage -> {
                    flush()
                    out += ImageSegment(n.destination.orEmpty(), textOf(n))
                }
                else -> n.children().forEach(::walk)
            }
        }
        node.children().forEach(::walk)
        flush()
        out
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (segment in segments) {
            when (segment) {
                is AnnotatedString -> Text(segment, style = style)
                is ImageSegment -> AgentImage(segment.src, segment.alt, env)
            }
        }
    }
}

private data class ImageSegment(val src: String, val alt: String)

/** 节点里的全部文字。 */
private fun textOf(node: Node): String = when (node) {
    is MdText -> node.literal
    is Code -> node.literal
    else -> node.children().joinToString("") { textOf(it) }
}

@Composable
private fun ListView(list: ListBlock) {
    val start = (list as? OrderedList)?.markerStartNumber ?: 1
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        list.children().forEachIndexed { index, item ->
            val task = item.firstChild as? TaskListItemMarker
            val marker = when {
                task != null -> if (task.isChecked) "☑" else "☐"
                list is OrderedList -> "${start + index}."
                else -> "•"
            }
            Row(Modifier.fillMaxWidth()) {
                Text(marker, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.widthIn(min = 22.dp).padding(end = 6.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (child in item.children()) if (child !is TaskListItemMarker) Block(child)
                }
            }
        }
    }
}

/** 代码块：等宽字体、简单的高亮、太宽的横着滚，右上角复制（复制的是代码原文，不带末尾的换行）。 */
@Composable
private fun CodeView(code: String, language: String) {
    val source = code.removeSuffix("\n")
    val dark = LocalDarkTheme.current
    val highlighted = remember(source, language, dark) { highlighted(source, language, dark) }
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth()) {
        Box {
            Text(
                highlighted,
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall,
                softWrap = false,
                modifier = Modifier.horizontalScroll(rememberScrollState()).padding(start = 12.dp, top = 12.dp, bottom = 12.dp, end = 48.dp),
            )
            IconButton(
                onClick = { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("", source))) } },
                modifier = Modifier.align(Alignment.TopEnd),
            ) {
                Icon(painterResource(R.drawable.ic_content_copy), contentDescription = stringResource(R.string.common_copy), modifier = Modifier.size(18.dp))
            }
        }
    }
}

private fun highlighted(code: String, language: String, dark: Boolean): AnnotatedString = buildAnnotatedString {
    append(code)
    for (span in highlightCode(code, language)) {
        val color = when (span.kind) {
            CodeKind.Keyword -> if (dark) Color(0xFFD2A8FF) else Color(0xFF8250DF)
            CodeKind.Str -> if (dark) Color(0xFFA5D6FF) else Color(0xFF0A3069)
            CodeKind.Comment -> if (dark) Color(0xFF8B949E) else Color(0xFF6E7781)
            CodeKind.Number -> if (dark) Color(0xFF79C0FF) else Color(0xFF0550AE)
        }
        addStyle(SpanStyle(color = color, fontStyle = if (span.kind == CodeKind.Comment) FontStyle.Italic else null), span.start, span.end)
    }
}

/** 表格：每一列按内容定宽（最宽 280dp），整张横着滚，窄屏上不把列挤成一个字一行。 */
@Composable
private fun TableView(table: TableBlock) {
    val rows = table.children().flatMap { section -> section.children().filterIsInstance<TableRow>().map { it to (section is TableHead) } }
    val columns = rows.maxOfOrNull { it.first.children().size } ?: 0
    if (columns == 0) return
    val border = MaterialTheme.colorScheme.outlineVariant
    Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Layout(
            content = {
                for ((row, head) in rows) {
                    val cells = row.children()
                    for (c in 0 until columns) {
                        val cell = cells.getOrNull(c) as? TableCell
                        Box(
                            Modifier
                                .border(0.5.dp, border)
                                .background(if (head) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                                .padding(horizontal = 10.dp, vertical = 6.dp),
                        ) {
                            if (cell != null) {
                                Inlines(cell, MaterialTheme.typography.bodyMedium.let { if (head) it.copy(fontWeight = FontWeight.SemiBold) else it })
                            }
                        }
                    }
                }
            },
        ) { measurables, _ ->
            val maxCell = 280.dp.roundToPx()
            val widths = IntArray(columns)
            measurables.forEachIndexed { i, m ->
                val c = i % columns
                widths[c] = maxOf(widths[c], minOf(maxCell, m.maxIntrinsicWidth(Constraints.Infinity)))
            }
            // 同一行的格子一样高（边框、底色对齐）：先按内容算出每一行的高度，再按这个宽高量
            val heights = measurables.chunked(columns).map { row ->
                row.mapIndexed { c, m -> m.maxIntrinsicHeight(widths[c]) }.max()
            }
            val placeables = measurables.mapIndexed { i, m ->
                val w = widths[i % columns]
                val h = heights[i / columns]
                m.measure(Constraints(minWidth = w, maxWidth = w, minHeight = h, maxHeight = h))
            }
            layout(widths.sum(), heights.sum()) {
                var y = 0
                placeables.chunked(columns).forEachIndexed { r, row ->
                    var x = 0
                    row.forEachIndexed { c, p ->
                        p.place(x, y)
                        x += widths[c]
                    }
                    y += heights[r]
                }
            }
        }
    }
}

/**
 * Agent 发的图片：GitHub 的和主站自己的直接显示；别的来源先是一个按钮，点了才加载。加载失败时显示成链接，
 * 点了（确认以后）交给浏览器。
 */
@Composable
private fun AgentImage(src: String, alt: String, env: MarkdownEnv) {
    val label = alt.ifBlank { stringResource(R.string.chat_image) }
    if (!isWebUrl(src) || env.images == null) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        return
    }
    var allowed by rememberSaveable(src) { mutableStateOf(false) }
    if (!allowed && !trustedImageHost(src, env.serverHost)) {
        TextButton(onClick = { allowed = true }) {
            Text("🖼 " + stringResource(R.string.chat_image_blocked, label, imageHost(src).orEmpty()))
        }
        return
    }
    val open = LocalOpenLink.current
    val state by produceState<ImageState>(ImageState.Loading, src) {
        value = env.images.load(src)?.let { ImageState.Loaded(it) } ?: ImageState.Failed
    }
    when (val s = state) {
        ImageState.Loading -> Box(Modifier.fillMaxWidth().height(120.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)))
        ImageState.Failed -> Text(
            "🖼 " + stringResource(R.string.chat_image_failed, label),
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier.clickable { open(src) }.padding(vertical = 4.dp),
        )
        is ImageState.Loaded -> Image(
            s.bitmap,
            contentDescription = alt.ifBlank { null },
            contentScale = ContentScale.Fit,
            modifier = Modifier.widthIn(max = 560.dp).fillMaxWidth(),
        )
    }
}

private sealed interface ImageState {
    data object Loading : ImageState
    data object Failed : ImageState
    data class Loaded(val bitmap: ImageBitmap) : ImageState
}
