package cn.seekcloud.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** 底栏的画法（#178）：安卓 13 以上是液态玻璃，省电模式、掉帧和安卓 12 退回毛玻璃，更老的系统是纯色。 */
class GlassRenderTest {
    @Test
    fun liquidNeedsAndroid13AndNoBatterySaverAndNoJank() {
        assertEquals(GlassRender.Liquid, chooseGlassRender(sdk = 34, powerSave = false, slow = false))
        assertEquals(GlassRender.Liquid, chooseGlassRender(sdk = 33, powerSave = false, slow = false))
        assertEquals(GlassRender.Frosted, chooseGlassRender(sdk = 34, powerSave = true, slow = false))
        assertEquals(GlassRender.Frosted, chooseGlassRender(sdk = 34, powerSave = false, slow = true))
        assertEquals(GlassRender.Frosted, chooseGlassRender(sdk = 32, powerSave = false, slow = false))
        assertEquals(GlassRender.Frosted, chooseGlassRender(sdk = 31, powerSave = false, slow = false))
        assertEquals(GlassRender.Solid, chooseGlassRender(sdk = 30, powerSave = false, slow = false))
        assertEquals(GlassRender.Solid, chooseGlassRender(sdk = 26, powerSave = true, slow = true))
    }

    @Test
    fun forcedRenderCannotBeBetterThanTheDeviceSupports() {
        assertEquals(GlassRender.Frosted, chooseGlassRender(sdk = 34, powerSave = false, slow = false, forced = GlassRender.Frosted))
        assertEquals(GlassRender.Solid, chooseGlassRender(sdk = 34, powerSave = false, slow = false, forced = GlassRender.Solid))
        assertEquals(GlassRender.Solid, chooseGlassRender(sdk = 30, powerSave = false, slow = false, forced = GlassRender.Liquid))
    }
}
