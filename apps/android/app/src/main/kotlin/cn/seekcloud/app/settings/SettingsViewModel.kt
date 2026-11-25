package cn.seekcloud.app.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.sessions.THINKING_EFFORTS
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 一项主站的设置：[value] 是现在的值（还没读到时为 null），[missing] 是主站没有这一项（比 App 旧，不显示），
 * [locked] 是设置规则不让改（写的时候主站回了 403，显示为不能修改）。
 */
data class SiteSetting<T>(val value: T? = null, val missing: Boolean = false, val locked: Boolean = false) {
    /** 读到了、能显示。 */
    val shown: Boolean get() = value != null && !missing
}

data class SiteSettingsUi(
    val effort: SiteSetting<String> = SiteSetting(),
    /** 默认思考强度列出的几档：能用的模型支持的，加上现在的值（照网页）。 */
    val efforts: List<String> = THINKING_EFFORTS,
    val grace: SiteSetting<Int> = SiteSetting(),
    /** 正在读。 */
    val loading: Boolean = false,
    /** 上一次读失败了（连不上、主站出错），页面上给"重试"。 */
    val failure: Throwable? = null,
)

/**
 * 设置里主站的那几项（#181，照网页的设置窗口）：每次进设置页重新读（在网页上改过也看得到）。
 * 改了当场保存：先显示新的值，没存上就拨回去，并通过 [messages] 说明原因；主站回 403 时把那一项标成不能修改。
 */
class SettingsViewModel(
    private val api: SiteSettingsApi,
    private val onSignedOut: () -> Unit,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {
    private val _ui = MutableStateFlow(SiteSettingsUi())
    val ui: StateFlow<SiteSettingsUi> = _ui.asStateFlow()

    private val _messages = Channel<Throwable>(Channel.BUFFERED)

    /** 没存上的原因，页面拿去显示一次。 */
    val messages: Flow<Throwable> = _messages.receiveAsFlow()

    private var loadJob: Job? = null

    /** 重新读一遍。正在保存的不会被读回来的旧值盖掉：读完时以本地正在显示的为准，只补没有的。 */
    fun refresh() {
        loadJob?.cancel()
        _ui.update { it.copy(loading = true) }
        loadJob = viewModelScope.launch {
            val effort = call { api.defaultEffort() }
            val grace = call { api.hostOfflineGrace() }
            val models = call { api.models() }
            val failure = effort.exceptionOrNull() ?: grace.exceptionOrNull()
            if (failure is ApiException && failure.status == 401) {
                onSignedOut()
                return@launch
            }
            val offered = models.getOrNull()?.models?.flatMap { it.efforts }?.toSet().orEmpty()
            _ui.update { ui ->
                ui.copy(
                    effort = effort.fold(
                        onSuccess = { value -> if (pendingEffort) ui.effort else ui.effort.copy(value = value, missing = value == null) },
                        onFailure = { ui.effort },
                    ),
                    grace = grace.fold(
                        onSuccess = { value -> if (pendingGrace) ui.grace else ui.grace.copy(value = value, missing = value == null) },
                        onFailure = { ui.grace },
                    ),
                    efforts = offeredEfforts(offered, effort.getOrNull() ?: ui.effort.value),
                    loading = false,
                    failure = failure,
                )
            }
        }
    }

    private var pendingEffort = false
    private var pendingGrace = false

    fun chooseEffort(effort: String) {
        val before = _ui.value.effort
        if (before.value == null || before.locked || before.value == effort) return
        _ui.update { it.copy(effort = before.copy(value = effort)) }
        pendingEffort = true
        viewModelScope.launch {
            val result = call { api.setDefaultEffort(effort) }
            pendingEffort = false
            result.onFailure { e ->
                _ui.update { it.copy(effort = before.copy(locked = locked(e))) }
                report(e)
            }
        }
    }

    fun chooseGrace(seconds: Int) {
        val before = _ui.value.grace
        if (before.value == null || before.locked || before.value == seconds) return
        _ui.update { it.copy(grace = before.copy(value = seconds)) }
        pendingGrace = true
        viewModelScope.launch {
            val result = call { api.setHostOfflineGrace(seconds) }
            pendingGrace = false
            result.onFailure { e ->
                _ui.update { it.copy(grace = before.copy(locked = locked(e))) }
                report(e)
            }
        }
    }

    private fun locked(e: Throwable) = e is ApiException && e.status == 403 && e.error?.code == "setting_locked"

    private fun report(e: Throwable) {
        if (e is ApiException && e.status == 401) onSignedOut() else _messages.trySend(e)
    }

    private suspend fun <T> call(block: () -> T): Result<T> = try {
        Result.success(withContext(io) { block() })
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(e)
    }

    companion object {
        /** 和主站 settings.ts 的 HOST_OFFLINE_GRACE_CHOICES 一致（秒）。 */
        val GRACE_CHOICES = listOf(60, 120, 300, 600, 1800)

        /** 照网页：能用的模型支持的几档加上现在的值；一个模型都没有时七档都列出来。 */
        fun offeredEfforts(offered: Set<String>, current: String?): List<String> {
            val shown = THINKING_EFFORTS.filter { it in offered || it == current }
            return shown.ifEmpty { THINKING_EFFORTS }
        }
    }
}
