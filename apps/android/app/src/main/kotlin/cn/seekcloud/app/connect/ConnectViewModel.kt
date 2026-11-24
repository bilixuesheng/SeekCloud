package cn.seekcloud.app.connect

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import cn.seekcloud.app.BuildConfig
import cn.seekcloud.app.net.PreferencesStore
import cn.seekcloud.app.net.ServerStore
import cn.seekcloud.app.net.probeServer
import cn.seekcloud.app.net.userAgent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** "连接服务器"页的状态：旋转屏幕、分屏时正在连的不会断（#204）。保存的主站和 App 别处读写的是同一份。 */
class ConnectViewModel(application: Application) : AndroidViewModel(application) {
    private val store = ServerStore(PreferencesStore(application))
    private val connector = Connector(store) { address, trust ->
        withContext(Dispatchers.IO) {
            val version = BuildConfig.VERSION_NAME
            probeServer(address, trust, version, userAgent(version, Build.VERSION.SDK_INT))
        }
    }

    private val _state = MutableStateFlow<ConnectState>(ConnectState.Idle)
    val state: StateFlow<ConnectState> = _state.asStateFlow()

    /** [editing] 是在给已经存着的一台改地址（#205）。 */
    fun connect(input: String, editing: String? = null) = run { connector.connect(input, editing) }

    fun allowCleartext() {
        val ask = _state.value as? ConnectState.AskCleartext ?: return
        run { connector.allowCleartext(ask) }
    }

    fun trustCertificate() {
        val ask = _state.value as? ConnectState.AskCertificate ?: return
        run { connector.trustCertificate(ask) }
    }

    /** 关掉确认的弹窗，或者改了地址：回到还没连的样子。[force] 是连上以后交出去了，清掉结果。 */
    fun reset(force: Boolean = false) {
        if (force || _state.value != ConnectState.Connecting) _state.value = ConnectState.Idle
    }

    private fun run(block: suspend () -> ConnectState) {
        if (_state.value == ConnectState.Connecting) return
        _state.value = ConnectState.Connecting
        viewModelScope.launch { _state.value = block() }
    }
}
