package cn.seekcloud.app.ui

import android.content.Intent
import android.icu.text.MeasureFormat
import android.icu.util.Measure
import android.icu.util.MeasureUnit
import android.icu.util.ULocale
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.seekcloud.app.BuildConfig
import cn.seekcloud.app.R
import cn.seekcloud.app.net.SavedServer
import cn.seekcloud.app.net.errorTexts
import cn.seekcloud.app.net.failureText
import cn.seekcloud.app.settings.AppPreferences
import cn.seekcloud.app.settings.SettingsViewModel
import cn.seekcloud.app.settings.SiteSetting
import cn.seekcloud.app.settings.SiteSettingsUi
import cn.seekcloud.app.settings.ThemeMode

/** 设置里的几页：分类列表，和点进去的每一类。 */
enum class SettingsPage { Home, General, Sessions, About }

/**
 * 底栏的"设置"（#181，照网页的设置窗口分类）：先是分类列表，点进去是每一类。主站的设置每次进来、从别处回到 App 时
 * 重新读（在网页上改过也看得到）；改了当场保存，没存上拨回去并在底部说明原因。
 * 外观、玻璃效果只存在这台设备上（[preferences]）。其余分类（账户、GitHub、模型、数据）做好以前在网页上改。
 */
@Composable
fun SettingsRoute(
    server: SavedServer,
    viewModel: SettingsViewModel,
    preferences: AppPreferences,
    render: GlassRender,
    onSwitchServer: () -> Unit,
    onSignOut: () -> Unit,
    bottomInset: Dp,
) {
    var page by rememberSaveable { mutableStateOf(SettingsPage.Home) }
    val ui by viewModel.ui.collectAsStateWithLifecycle()
    val theme by preferences.theme.collectAsStateWithLifecycle()
    val glass by preferences.glass.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val resources = LocalResources.current
    // 进设置、从浏览器回到 App 时重新读
    LifecycleResumeEffect(viewModel) {
        viewModel.refresh()
        onPauseOrDispose {}
    }
    LaunchedEffect(viewModel) {
        viewModel.messages.collect { snackbar.showSnackbar(failureText(it, resources.errorTexts())) }
    }
    if (page != SettingsPage.Home) BackHandler { page = SettingsPage.Home }
    val animationsOff = rememberAnimationsOff()
    AnimatedContent(
        targetState = page,
        transitionSpec = {
            if (animationsOff) {
                fadeIn(tween(0)) togetherWith fadeOut(tween(0))
            } else {
                // 进去从右边滑进来，回来往右边滑出去
                val forward = targetState != SettingsPage.Home
                (slideInHorizontally(tween(260)) { if (forward) it / 3 else -it / 3 } + fadeIn(tween(200))) togetherWith
                    (slideOutHorizontally(tween(260)) { if (forward) -it / 3 else it / 3 } + fadeOut(tween(160)))
            }
        },
        label = "settings-page",
    ) { current ->
        val back = { page = SettingsPage.Home }
        when (current) {
            SettingsPage.Home -> SettingsHome(
                server = server,
                ui = ui,
                onOpen = { page = it },
                onSwitchServer = onSwitchServer,
                onSignOut = onSignOut,
                snackbar = snackbar,
                bottomInset = bottomInset,
            )
            SettingsPage.General -> SettingsSubpage(stringResource(R.string.settings_section_general), back, snackbar, bottomInset) {
                AppearanceSection(theme, preferences::setTheme, glass, preferences::setGlass, render)
                EffortSection(ui, viewModel::chooseEffort, viewModel::refresh)
            }
            SettingsPage.Sessions -> SettingsSubpage(stringResource(R.string.settings_section_sessions), back, snackbar, bottomInset) {
                GraceSection(ui, viewModel::chooseGrace, viewModel::refresh)
            }
            SettingsPage.About -> SettingsSubpage(stringResource(R.string.settings_about), back, snackbar, bottomInset) {
                AboutSection()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsHome(
    server: SavedServer,
    ui: SiteSettingsUi,
    onOpen: (SettingsPage) -> Unit,
    onSwitchServer: () -> Unit,
    onSignOut: () -> Unit,
    snackbar: SnackbarHostState,
    bottomInset: Dp,
) {
    val context = LocalContext.current
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    val host = server.address?.host ?: server.origin
    Scaffold(
        topBar = { TopAppBar(title = { Text(stringResource(R.string.settings_title)) }) },
        snackbarHost = { SnackbarHost(snackbar, Modifier.padding(bottom = bottomInset)) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        SettingsColumn(Modifier.padding(padding), bottomInset) {
            // 主站的设置（每台主站各是各的）
            CategoryRow(R.drawable.ic_tune, stringResource(R.string.settings_section_general)) { onOpen(SettingsPage.General) }
            // 主站比 App 旧、没有这一项时不显示
            if (!ui.grace.missing) {
                CategoryRow(R.drawable.ic_chat_bubble, stringResource(R.string.settings_section_sessions)) { onOpen(SettingsPage.Sessions) }
            }
            CategoryRow(
                R.drawable.ic_open_in_new,
                stringResource(R.string.settings_web),
                hint = stringResource(R.string.settings_web_hint),
            ) {
                context.startActivity(Intent(Intent.ACTION_VIEW, "${server.origin}/settings".toUri()))
            }

            SectionDivider()
            SectionTitle(stringResource(R.string.settings_app))
            CategoryRow(R.drawable.ic_dns, stringResource(R.string.settings_server), hint = host, onClick = onSwitchServer)
            CategoryRow(
                R.drawable.ic_info,
                stringResource(R.string.settings_about),
                hint = stringResource(R.string.settings_version, BuildConfig.VERSION_NAME),
            ) { onOpen(SettingsPage.About) }
            CategoryRow(R.drawable.ic_logout, stringResource(R.string.sign_out), danger = true, chevron = false) { confirmSignOut = true }
        }
    }
    if (confirmSignOut) {
        ConfirmDialog(
            title = stringResource(R.string.sign_out_title),
            body = stringResource(R.string.sign_out_body, host),
            confirm = stringResource(R.string.sign_out),
            onConfirm = {
                confirmSignOut = false
                onSignOut()
            },
            onDismiss = { confirmSignOut = false },
        )
    }
}

/** 点进去的一类：顶栏有返回。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsSubpage(
    title: String,
    onBack: () -> Unit,
    snackbar: SnackbarHostState,
    bottomInset: Dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(painterResource(R.drawable.ic_arrow_back), contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbar, Modifier.padding(bottom = bottomInset)) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { padding ->
        SettingsColumn(Modifier.padding(padding), bottomInset, content)
    }
}

/** 设置页的内容：能滚动，宽屏时不拉得太宽，最后留出底栏的高度。 */
@Composable
private fun SettingsColumn(modifier: Modifier, bottomInset: Dp, content: @Composable ColumnScope.() -> Unit) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        Column(
            Modifier
                .widthIn(max = 640.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(top = 4.dp, bottom = bottomInset + 16.dp),
            content = content,
        )
    }
}

/** 外观：跟随系统、浅色、深色，加上玻璃效果的两版。都只存在这台设备上。 */
@Composable
private fun AppearanceSection(
    theme: ThemeMode,
    onTheme: (ThemeMode) -> Unit,
    glass: GlassStyle,
    onGlass: (GlassStyle) -> Unit,
    render: GlassRender,
) {
    SectionTitle(stringResource(R.string.general_appearance))
    Column(Modifier.selectableGroup()) {
        for (mode in listOf(ThemeMode.System, ThemeMode.Light, ThemeMode.Dark)) {
            OptionRow(
                title = stringResource(
                    when (mode) {
                        ThemeMode.System -> R.string.general_theme_system
                        ThemeMode.Light -> R.string.general_theme_light
                        ThemeMode.Dark -> R.string.general_theme_dark
                    },
                ),
                selected = theme == mode,
            ) { onTheme(mode) }
        }
    }
    Text(
        stringResource(R.string.settings_glass),
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 12.dp, bottom = 4.dp),
    )
    Column(Modifier.selectableGroup()) {
        OptionRow(
            title = stringResource(R.string.settings_glass_colorful),
            hint = stringResource(R.string.settings_glass_colorful_hint),
            selected = glass == GlassStyle.Colorful,
        ) { onGlass(GlassStyle.Colorful) }
        OptionRow(
            title = stringResource(R.string.settings_glass_plain),
            hint = stringResource(R.string.settings_glass_plain_hint),
            selected = glass == GlassStyle.Plain,
        ) { onGlass(GlassStyle.Plain) }
    }
    if (render != GlassRender.Liquid) Hint(stringResource(R.string.settings_glass_frosted))
    Hint(stringResource(R.string.settings_appearance_hint))
}

/** 新会话默认的思考强度（主站的设置）：只列出能用的模型支持的几档。 */
@Composable
private fun EffortSection(ui: SiteSettingsUi, onChoose: (String) -> Unit, onRetry: () -> Unit) {
    if (ui.effort.missing) return
    SectionDivider()
    SectionTitle(stringResource(R.string.general_effort))
    SiteSettingBody(ui, ui.effort, onRetry) { current ->
        Column(Modifier.selectableGroup()) {
            for (effort in ui.efforts) {
                OptionRow(title = effortName(effort), selected = current == effort, enabled = !ui.effort.locked) { onChoose(effort) }
            }
        }
        Hint(stringResource(R.string.general_effort_hint))
    }
}

/** 会话：宿主机断开后等多久把它上面运行中的会话标为失败（主站的设置）。 */
@Composable
private fun GraceSection(ui: SiteSettingsUi, onChoose: (Int) -> Unit, onRetry: () -> Unit) {
    SectionTitle(stringResource(R.string.session_settings_grace))
    SiteSettingBody(ui, ui.grace, onRetry) { current ->
        val locale = LocalConfiguration.current.locales[0]
        Column(Modifier.selectableGroup()) {
            for (seconds in SettingsViewModel.GRACE_CHOICES) {
                OptionRow(title = minutesText(seconds / 60, locale), selected = current == seconds, enabled = !ui.grace.locked) {
                    onChoose(seconds)
                }
            }
        }
        Hint(stringResource(R.string.session_settings_grace_hint))
    }
}

/** 时长按系统语言写（"5 分钟"、"5 minutes"），和网页的 minutesParts 一样交给系统的格式。 */
private fun minutesText(minutes: Int, locale: java.util.Locale): String =
    MeasureFormat.getInstance(ULocale.forLocale(locale), MeasureFormat.FormatWidth.WIDE).format(Measure(minutes, MeasureUnit.MINUTE))

/** 一项主站的设置：还没读到时转圈或给"重试"；读到了显示 [content]；不让改时在下面说明。 */
@Composable
private fun <T> SiteSettingBody(
    ui: SiteSettingsUi,
    setting: SiteSetting<T>,
    onRetry: () -> Unit,
    content: @Composable (T) -> Unit,
) {
    val value = setting.value
    when {
        value != null -> {
            content(value)
            if (setting.locked) Hint(stringResource(R.string.error_setting_locked), error = true)
        }
        ui.failure != null && !ui.loading -> Row(
            Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                stringResource(R.string.settings_load_failed),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onRetry) { Text(stringResource(R.string.settings_retry)) }
        }
        else -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
        }
    }
}

// 不是界面文案：附加条款规定的署名原文（NOTICE），两种语言下都照原文显示，不翻译（和网页的开源声明页一样）
private const val ATTRIBUTION = "基于 SeekCloud"
private const val SOURCE_URL = "https://github.com/bilixuesheng/SeekCloud"
private const val AGPL_URL = "https://www.gnu.org/licenses/agpl-3.0.html"

/**
 * 关于：版本、SeekCloud 自己的署名和许可证（和网页开源声明页的开头一样）。
 * "基于 SeekCloud"这句署名是 NOTICE 里的附加条款（AGPL-3.0 第 7 条 (b) 项）要求保留的，改过的版本也不能删；
 * 仓库地址同时是 AGPL-3.0 第 13 条要求的源代码获取方式。App 用到的开源软件的声明是 #125。
 */
@Composable
private fun AboutSection() {
    val context = LocalContext.current
    val linkStyle = TextLinkStyles(SpanStyle(color = MaterialTheme.colorScheme.primary, textDecoration = TextDecoration.Underline))
    Column(Modifier.padding(horizontal = 24.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge)
        Text(
            stringResource(R.string.settings_version, BuildConfig.VERSION_NAME),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        val meaning = stringResource(R.string.legal_attribution_meaning)
        Text(
            buildAnnotatedString {
                append("$ATTRIBUTION（")
                withLink(LinkAnnotation.Url(SOURCE_URL, linkStyle)) { append(SOURCE_URL) }
                append("）")
                if (meaning.isNotEmpty()) append(" $meaning")
            },
            style = MaterialTheme.typography.bodyMedium,
        )
        // 不是界面文案：版权声明照 NOTICE 原文
        Text("Copyright (C) 2026 XUESHENG", style = MaterialTheme.typography.bodyMedium)
        val agpl = stringResource(R.string.legal_agpl)
        val license = stringResource(R.string.legal_license, "\u0000")
        Text(
            buildAnnotatedString {
                val at = license.indexOf('\u0000')
                append(license.substring(0, at))
                withLink(LinkAnnotation.Url(AGPL_URL, linkStyle)) { append(agpl) }
                append(license.substring(at + 1))
            },
            style = MaterialTheme.typography.bodyMedium,
        )
    }
    CategoryRow(R.drawable.ic_code, stringResource(R.string.settings_source), hint = SOURCE_URL, chevron = false) {
        context.startActivity(Intent(Intent.ACTION_VIEW, SOURCE_URL.toUri()))
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 24.dp, end = 24.dp, top = 12.dp, bottom = 4.dp).semantics { heading() },
    )
}

@Composable
private fun SectionDivider() {
    HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
}

@Composable
private fun Hint(text: String, error: Boolean = false) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 24.dp, vertical = 4.dp),
    )
}

/** 分类列表的一行：图标、名称、下面一行说明，右边的箭头表示点进去还有一页。 */
@Composable
private fun CategoryRow(
    icon: Int,
    title: String,
    hint: String? = null,
    danger: Boolean = false,
    chevron: Boolean = true,
    onClick: () -> Unit,
) {
    val color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painterResource(icon),
            contentDescription = null,
            tint = if (danger) color else MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(24.dp),
        )
        Spacer(Modifier.width(20.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = color)
            if (hint != null) {
                Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (chevron) {
            Icon(
                painterResource(R.drawable.ic_chevron_right),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/** 单选的一行（整行能点，读屏读成单选按钮）。 */
@Composable
private fun OptionRow(title: String, selected: Boolean, hint: String? = null, enabled: Boolean = true, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Column(Modifier.padding(start = 8.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
