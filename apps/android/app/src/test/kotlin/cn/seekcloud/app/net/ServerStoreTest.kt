package cn.seekcloud.app.net

import cn.seekcloud.app.connect.MemoryStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 保存的主站（#204）：同一个地址只留一份，最后连上的是现在用的；存坏了当作没存。 */
class ServerStoreTest {
    private val memory = MemoryStore()
    private val store = ServerStore(memory)

    @Test
    fun emptyAtFirst() {
        assertEquals(emptyList<SavedServer>(), store.servers())
        assertNull(store.current())
    }

    @Test
    fun savingTheSameAddressReplacesItAndMakesItCurrent() {
        store.save(SavedServer("https://a.example.com"))
        store.save(SavedServer("http://192.168.1.5:8080", allowCleartext = true))
        assertEquals("http://192.168.1.5:8080", store.current()?.origin)
        store.save(SavedServer("https://a.example.com", pinnedCertificate = "AA"))
        assertEquals(SavedServer("https://a.example.com", pinnedCertificate = "AA"), store.current())
        assertEquals(2, store.servers().size)
        assertEquals("AA", store.find(ServerAddress(true, "a.example.com", null))?.pinnedCertificate)
        assertNull(store.find(ServerAddress(true, "a.example.com", 8443)))
    }

    @Test
    fun survivesAcrossInstances() {
        store.save(SavedServer("https://a.example.com"))
        assertEquals(SavedServer("https://a.example.com"), ServerStore(memory).current())
    }

    @Test
    fun corruptDataIsTreatedAsEmpty() {
        memory.put("servers", "{not json")
        assertEquals(emptyList<SavedServer>(), store.servers())
        store.save(SavedServer("https://a.example.com"))
        assertEquals(1, store.servers().size)
    }
}
