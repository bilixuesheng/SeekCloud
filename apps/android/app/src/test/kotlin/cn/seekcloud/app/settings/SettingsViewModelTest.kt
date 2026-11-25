package cn.seekcloud.app.settings

import cn.seekcloud.app.net.ApiError
import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.sessions.ModelList
import cn.seekcloud.app.sessions.ModelOption
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** 设置里主站的那几项（#181）：读、当场保存、存不上拨回、被锁住、主站没有这一项。 */
@OptIn(ExperimentalCoroutinesApi::class)
class SettingsViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @Before
    fun setUp() = Dispatchers.setMain(dispatcher)

    @After
    fun tearDown() = Dispatchers.resetMain()

    private class FakeApi : SiteSettingsApi {
        var effort: String? = "high"
        var grace: Int? = 300
        var failWrite: Exception? = null
        var failRead: Exception? = null
        var models = ModelList(models = listOf(ModelOption("deepseek/v4", efforts = listOf("off", "high", "max"))))
        val writes = mutableListOf<Any>()

        override fun defaultEffort(): String? {
            failRead?.let { throw it }
            return effort
        }

        override fun setDefaultEffort(effort: String) {
            failWrite?.let { throw it }
            writes += effort
            this.effort = effort
        }

        override fun hostOfflineGrace(): Int? {
            failRead?.let { throw it }
            return grace
        }

        override fun setHostOfflineGrace(seconds: Int) {
            failWrite?.let { throw it }
            writes += seconds
            grace = seconds
        }

        override fun models() = models
    }

    private fun viewModel(api: SiteSettingsApi, onSignedOut: () -> Unit = {}) =
        SettingsViewModel(api, onSignedOut, io = dispatcher).also { it.refresh() }

    @Test
    fun readsSettingsAndOffersTheModelsEfforts() = runTest(dispatcher) {
        val vm = viewModel(FakeApi())
        advanceUntilIdle()
        val ui = vm.ui.value
        assertEquals("high", ui.effort.value)
        assertEquals(300, ui.grace.value)
        // 只列能用的模型支持的几档，按从低到高
        assertEquals(listOf("off", "high", "max"), ui.efforts)
        assertFalse(ui.loading)
        assertNull(ui.failure)
    }

    @Test
    fun keepsTheCurrentEffortEvenIfNoModelOffersIt() {
        assertEquals(listOf("low", "high"), SettingsViewModel.offeredEfforts(setOf("high"), "low"))
        // 一个模型都没有时七档都列出来
        assertEquals(7, SettingsViewModel.offeredEfforts(emptySet(), null).size)
    }

    @Test
    fun savesRightAway() = runTest(dispatcher) {
        val api = FakeApi()
        val vm = viewModel(api)
        advanceUntilIdle()
        vm.chooseEffort("max")
        // 先显示新的值
        assertEquals("max", vm.ui.value.effort.value)
        vm.chooseGrace(600)
        advanceUntilIdle()
        assertEquals(listOf<Any>("max", 600), api.writes)
        assertEquals(600, vm.ui.value.grace.value)
    }

    @Test
    fun revertsAndExplainsWhenSavingFails() = runTest(dispatcher) {
        val api = FakeApi()
        val vm = viewModel(api)
        advanceUntilIdle()
        api.failWrite = IOException("offline")
        vm.chooseGrace(1800)
        assertEquals(1800, vm.ui.value.grace.value)
        advanceUntilIdle()
        // 拨回去，并说明原因
        assertEquals(300, vm.ui.value.grace.value)
        assertFalse(vm.ui.value.grace.locked)
        assertTrue(vm.messages.first() is IOException)
    }

    @Test
    fun aLockedSettingCannotBeChangedAnyMore() = runTest(dispatcher) {
        val api = FakeApi()
        val vm = viewModel(api)
        advanceUntilIdle()
        api.failWrite = ApiException(403, ApiError("setting_locked", "这项设置不能修改"))
        vm.chooseEffort("off")
        advanceUntilIdle()
        assertEquals("high", vm.ui.value.effort.value)
        assertTrue(vm.ui.value.effort.locked)
        assertEquals("setting_locked", (vm.messages.first() as ApiException).error?.code)
        // 标成不能修改以后不再发请求
        api.failWrite = null
        vm.chooseEffort("max")
        advanceUntilIdle()
        assertEquals("high", vm.ui.value.effort.value)
        assertTrue(api.writes.isEmpty())
        // 重新读不会把"不能修改"去掉（主站读的时候不说能不能改）
        vm.refresh()
        advanceUntilIdle()
        assertTrue(vm.ui.value.effort.locked)
    }

    @Test
    fun hidesSettingsTheSiteDoesNotHave() = runTest(dispatcher) {
        val api = FakeApi().apply { grace = null }
        val vm = viewModel(api)
        advanceUntilIdle()
        assertTrue(vm.ui.value.grace.missing)
        assertFalse(vm.ui.value.grace.shown)
        assertTrue(vm.ui.value.effort.shown)
    }

    @Test
    fun rereadsChangesMadeOnTheWeb() = runTest(dispatcher) {
        val api = FakeApi()
        val vm = viewModel(api)
        advanceUntilIdle()
        api.effort = "off"
        vm.refresh()
        advanceUntilIdle()
        assertEquals("off", vm.ui.value.effort.value)
    }

    @Test
    fun aFailedReadOffersRetry() = runTest(dispatcher) {
        val api = FakeApi().apply { failRead = IOException("offline") }
        val vm = viewModel(api)
        advanceUntilIdle()
        assertNull(vm.ui.value.effort.value)
        assertTrue(vm.ui.value.failure is IOException)
        api.failRead = null
        vm.refresh()
        advanceUntilIdle()
        assertEquals("high", vm.ui.value.effort.value)
        assertNull(vm.ui.value.failure)
    }

    @Test
    fun signsOutWhenTheTokenIsRevoked() = runTest(dispatcher) {
        var signedOut = false
        val api = FakeApi().apply { failRead = ApiException(401, ApiError("not_logged_in", "")) }
        viewModel(api) { signedOut = true }
        advanceUntilIdle()
        assertTrue(signedOut)
    }
}
