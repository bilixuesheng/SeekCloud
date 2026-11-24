package cn.seekcloud.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import cn.seekcloud.app.connect.ConnectRoute
import cn.seekcloud.app.ui.SeekCloudTheme

/** 唯一的 Activity：界面都在 Compose 里。旋转、分屏、深色模式切换时页面状态由 rememberSaveable 保住（#123）。 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SeekCloudTheme {
                ConnectRoute()
            }
        }
    }
}
