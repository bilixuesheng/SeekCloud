package cn.seekcloud.app.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.seekcloud.app.net.EventStreamClosed
import cn.seekcloud.app.net.ServerClient
import cn.seekcloud.app.net.eventStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * 会话列表（#124）：连着主站的会话列表事件流，新会话、状态变化、改名、删除马上反映出来。
 * 断了自动重连，重连时主站先发一份完整的列表（snapshot），断开期间的变化就补上了；断着时列表照旧显示上次的内容。
 * App 在后台时不连（[stop]），回到前台再连（[start]）。设备被退出了（401）交给 [onSignedOut]。
 */
class SessionListViewModel(
    private val client: ServerClient,
    private val onSignedOut: () -> Unit,
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

    fun start() {
        job?.cancel()
        job = viewModelScope.launch {
            try {
                val url = client.address.url("/api/sessions/stream")
                eventStream(client.http, url, onConnected = ::onConnected).collect { event ->
                    // 几百个会话的列表也不在界面线程上解析
                    _state.value = withContext(Dispatchers.Default) { _state.value.apply(event.event, event.data) }
                    if (event.event == "snapshot") _refreshing.value = false
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
