package cn.seekcloud.app.net

import cn.seekcloud.app.connect.MemoryStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * 保存的主站（#204、#205）：同一个地址只留一份，最后连上的是现在用的；编号不随地址变；
 * 改地址撞上另一台时并成一台；删掉现在用的换到剩下的；存坏了当作没存。
 */
class ServerStoreTest {
    private val memory = MemoryStore()
    private var next = 0
    private val store = ServerStore(memory) { "s${++next}" }

    private val a = ServerAddress(true, "a.example.com", null)
    private val b = ServerAddress(false, "192.168.1.5", 8080)
    private val c = ServerAddress(true, "c.example.com", null)

    @Test
    fun emptyAtFirst() {
        assertEquals(emptyList<SavedServer>(), store.servers())
        assertNull(store.current())
    }

    @Test
    fun savingTheSameAddressUpdatesItAndMakesItCurrent() {
        val first = store.save(a, ServerTrust())
        store.save(b, ServerTrust(allowCleartext = true))
        assertEquals("http://192.168.1.5:8080", store.current()?.origin)
        val again = store.save(a, ServerTrust(pinnedCertificate = "AA"))
        assertEquals(first.id, again.id)
        assertEquals(SavedServer("s1", "https://a.example.com", pinnedCertificate = "AA"), store.current())
        assertEquals(listOf("s1", "s2"), store.servers().map { it.id })
        assertEquals("AA", store.find(a)?.pinnedCertificate)
        assertNull(store.find(ServerAddress(true, "a.example.com", 8443)))
    }

    @Test
    fun changingTheAddressKeepsTheId() {
        val server = store.save(a, ServerTrust())
        store.save(b, ServerTrust(allowCleartext = true))
        val (moved, merged) = store.changeAddress(server.id, c, ServerTrust(pinnedCertificate = "CC"))
        assertNull(merged)
        assertEquals(SavedServer("s1", "https://c.example.com", pinnedCertificate = "CC"), moved)
        assertEquals(moved, store.current())
        assertEquals(listOf("https://c.example.com", "http://192.168.1.5:8080"), store.servers().map { it.origin })
    }

    @Test
    fun changingToAnAddressSavedAsAnotherServerMergesThem() {
        val first = store.save(a, ServerTrust())
        val second = store.save(c, ServerTrust())
        val (moved, merged) = store.changeAddress(first.id, c, ServerTrust())
        assertEquals(second.id, merged)
        assertEquals(listOf(moved), store.servers())
        assertEquals(first.id, store.current()?.id)
    }

    @Test
    fun selectAndRemove() {
        val first = store.save(a, ServerTrust())
        val second = store.save(b, ServerTrust(allowCleartext = true))
        store.select(first.id)
        assertEquals(first.id, store.current()?.id)
        store.select("missing")
        assertEquals(first.id, store.current()?.id)
        store.remove(first.id)
        assertEquals(second.id, store.current()?.id)
        store.remove(second.id)
        assertNull(store.current())
        assertEquals(emptyList<SavedServer>(), store.servers())
    }

    @Test
    fun survivesAcrossInstances() {
        val server = store.save(a, ServerTrust())
        assertEquals(server, ServerStore(memory).current())
    }

    @Test
    fun corruptDataIsTreatedAsEmpty() {
        memory.put("servers", "{not json")
        assertEquals(emptyList<SavedServer>(), store.servers())
        store.save(a, ServerTrust())
        assertEquals(1, store.servers().size)
    }
}
