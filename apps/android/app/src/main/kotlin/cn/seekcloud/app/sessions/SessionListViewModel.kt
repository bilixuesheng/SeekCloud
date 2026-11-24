package cn.seekcloud.app.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.EventStreamClosed
import cn.seekcloud.app.net.ServerClient
import cn.seekcloud.app.net.eventStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.cancellation.CancellationException

/**
 * 会话列表（#124）：连着主站的会话列表事件流，新会话、状态变化、改名、删除马上反映出来。
 * 断了自动重连，重连时主站先发一份完整的列表（snapshot），断开期间的变化就补上了；断着时列表照旧显示上次的内容。
 * App 在后台时不连（[stop]），回到前台再连（[start]）。设备被退出了（401）交给 [onSignedOut]。
 */
class SessionListViewModel(
    private val client: ServerClient,
    private val onSignedOut: () -> Unit,
    private val actions: SessionActions = SessionsApi(client),
) : ViewModel() {
    private val _state = MutableStateFlow(SessionListState())
    val state: StateFlow<SessionListState> = _state.asStateFlow()

    /** 事件流连着没有：没连上时界面顶部提示"连接已断开，正在重连"。 */
    private val _connected = MutableStateFlow(true)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    /** 下拉刷新转着圈：重新连一次，等主站发来新的完整列表。 */
    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    private var job: Job? = null

    /** 开着菜单的那个会话和菜单现在在哪一页；关着时为 null。转屏不丢。 */
    private val _menu = MutableStateFlow<MenuUi?>(null)
    val menu: StateFlow<MenuUi?> = _menu.asStateFlow()

    fun openMenu(shortId: String) {
        _menu.value = MenuUi(shortId)
    }

    fun closeMenu() {
        if (_menu.value?.busy != true) _menu.value = null
    }

    fun showPage(page: MenuPage) {
        _menu.update { it?.copy(page = page, failure = null) }
    }

    /**
     * 做一项菜单里的操作。成功了关菜单，列表等事件流推回来的（以主站为准）；失败了留在这一页说明原因；
     * 设备被退出了回登录页。
     */
    fun perform(action: SessionActions.(shortId: String) -> Unit) {
        val current = _menu.value ?: return
        if (current.busy) return
        _menu.value = current.copy(busy = true, failure = null)
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { actions.action(current.shortId) }
                _menu.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ApiException && e.status == 401) onSignedOut()
                _menu.update { it?.copy(busy = false, failure = e) }
            }
        }
    }

    fun start() {
        job?.cancel()
        job = viewModelScope.launch {
            try {
                val url = client.address.url("/api/sessions/stream")
                eventStream(client.http, url, onConnected = ::onConnected).collect { event ->
                    // 几百个会话的列表也不在界面线程上解析
                    _state.value = withContext(Dispatchers.Default) { _state.value.apply(event.event, event.data) }
                    if (event.event == "snapshot") _refreshing.value = false
                    // 开着菜单的会话被删了（别处删的，或者刚在菜单里删的）：关掉菜单
                    val open = _menu.value
                    if (open != null && _state.value.sessions.none { it.shortId == open.shortId }) _menu.value = null
                }
            } catch (e: EventStreamClosed) {
                if (e.status == 401) onSignedOut()
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }

    fun refresh() {
        _refreshing.value = true
        start()
    }

    private fun onConnected(connected: Boolean) {
        _connected.value = connected
        if (!connected) _refreshing.value = false
    }
}

/** 会话菜单的几页（照网页的 SessionMenu）。 */
enum class MenuPage { Main, OpenOn, Rename, Delete, Group, NewGroup }

data class MenuUi(
    val shortId: String,
    val page: MenuPage = MenuPage.Main,
    val busy: Boolean = false,
    val failure: Throwable? = null,
)
