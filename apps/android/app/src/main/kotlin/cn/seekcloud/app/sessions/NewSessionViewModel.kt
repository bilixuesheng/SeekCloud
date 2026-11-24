package cn.seekcloud.app.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import cn.seekcloud.app.net.ApiException
import cn.seekcloud.app.net.KeyValueStore
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** 上次用的仓库、分支和模型（照网页：思考强度不记，每次从设置里的默认值开始）。 */
@Serializable
data class Remembered(val repo: Repo? = null, val branch: String? = null, val model: String? = null)

/** 新会话页现在的样子。 */
data class NewSessionUi(
    val text: String = "",
    /** GitHub 的状态回来（或者取失败）以前不能发送：免得记着的仓库还没认出来，就发成了不使用仓库的会话。 */
    val githubChecked: Boolean = false,
    val github: GitHubStatus? = null,
    val environments: List<Environment> = emptyList(),
    val environmentId: String? = null,
    val models: ModelList? = null,
    val chosenModel: String? = null,
    val chosenEffort: String? = null,
    val repo: Repo? = null,
    val branch: String? = null,
    val branches: List<String> = emptyList(),
    val busy: Boolean = false,
    val failure: Throwable? = null,
    /** 发起成功的会话：界面打开它，然后关掉这一页。 */
    val created: SessionSummary? = null,
) {
    val connected: Boolean
        get() = github?.connected == true

    /** 没关联 GitHub 时记着的仓库用不上：发起不使用仓库的会话。 */
    val chosenRepo: Repo?
        get() = if (connected) repo else null

    /** 记住的模型下线了就换回默认的。 */
    val model: String?
        get() = models?.let { list -> chosenModel?.takeIf { id -> list.models.any { it.id == id } } ?: list.defaultModel }

    /** 没动过就用设置里的默认值；模型不支持那一档时换成最近的一档；模型没声明推理等级时只有"关闭"。 */
    val effort: String
        get() {
            val efforts = models?.models?.firstOrNull { it.id == model }?.efforts.orEmpty()
            if (efforts.isEmpty()) return "off"
            return fitEffort(efforts, chosenEffort ?: models?.defaultEffort ?: "high") ?: "high"
        }

    val canSubmit: Boolean
        get() = text.isNotBlank() && githubChecked && !busy && model != null
}

/** 仓库选择弹层：搜的字、列表、出错。 */
data class RepoSearch(val query: String = "", val repos: List<Repo>? = null, val failure: Throwable? = null)

/**
 * 新会话页（#124，照网页的 NewSession）：写一句话，选环境、仓库（可以不选，#191）、分支和模型，发起会话。
 * 没发出去的字和上次的选择记在这台设备上（[store]，每台主站各记各的）。
 */
class NewSessionViewModel(
    private val source: NewSessionSource,
    private val store: KeyValueStore,
    private val serverId: String,
    private val onSignedOut: () -> Unit,
) : ViewModel() {
    private val remembered: Remembered =
        store.get("choices:$serverId")?.let { runCatching { json.decodeFromString<Remembered>(it) }.getOrNull() } ?: Remembered()

    private val _ui = MutableStateFlow(
        NewSessionUi(
            text = store.get("draft:$serverId").orEmpty(),
            repo = remembered.repo,
            branch = remembered.branch ?: remembered.repo?.defaultBranch,
            branches = listOfNotNull(remembered.repo?.defaultBranch),
            chosenModel = remembered.model,
        ),
    )
    val ui: StateFlow<NewSessionUi> = _ui.asStateFlow()

    private val _repos = MutableStateFlow(RepoSearch())
    val repos: StateFlow<RepoSearch> = _repos.asStateFlow()
    private var allRepos: List<Repo>? = null
    private var searchJob: Job? = null

    init {
        load()
    }

    private fun load() {
        viewModelScope.launch {
            val github = io { source.github() }
            _ui.update { it.copy(github = github.getOrNull(), githubChecked = true) }
            if (github.getOrNull()?.connected == true) {
                loadRepos()
                _ui.value.repo?.let { loadBranches(it) }
            }
        }
        viewModelScope.launch {
            io { source.environments() }.getOrNull()?.let { envs ->
                _ui.update { it.copy(environments = envs, environmentId = envs.firstOrNull { e -> e.isDefault }?.id) }
            }
        }
        viewModelScope.launch {
            io { source.models() }.getOrNull()?.let { models -> _ui.update { it.copy(models = models) } }
        }
    }

    fun setText(text: String) {
        _ui.update { it.copy(text = text, failure = null) }
        store.put("draft:$serverId", text)
    }

    fun setEnvironment(id: String) = _ui.update { it.copy(environmentId = id) }

    fun setBranch(branch: String) = _ui.update { it.copy(branch = branch) }

    /** 选了仓库（null 是不使用仓库）：分支先换成它的默认分支，再去拉分支列表。 */
    fun pickRepo(repo: Repo?) {
        _ui.update { it.copy(repo = repo, branch = repo?.defaultBranch, branches = listOfNotNull(repo?.defaultBranch)) }
        repo?.let { viewModelScope.launch { loadBranches(it) } }
    }

    /** 换了模型：也就成了新会话的默认模型（别的设备、下次打开都用它）。 */
    fun setModel(model: String, effort: String) {
        val previous = _ui.value.model
        _ui.update { it.copy(chosenModel = model, chosenEffort = effort) }
        if (model != previous) viewModelScope.launch { io { source.setDefaultModel(model) } }
    }

    /** 仓库弹层里搜：先在装了 App 的仓库里筛，停下来 250 毫秒再问主站（含公开仓库）。 */
    fun searchRepos(query: String) {
        val q = query.trim()
        searchJob?.cancel()
        val local = allRepos?.filter { it.fullName.contains(q, ignoreCase = true) }
        _repos.value = RepoSearch(query, if (q.isEmpty()) allRepos else local, null)
        if (q.isEmpty()) return
        searchJob = viewModelScope.launch {
            delay(250)
            val found = io { source.repos(q) }
            _repos.update { current ->
                if (current.query != query) current
                else found.fold({ current.copy(repos = it, failure = null) }, { current.copy(failure = it) })
            }
        }
    }

    fun create() {
        val ui = _ui.value
        if (!ui.canSubmit) return
        val repo = ui.chosenRepo
        _ui.update { it.copy(busy = true, failure = null) }
        viewModelScope.launch {
            val request = NewSessionRequest(
                text = ui.text,
                repo = repo?.fullName,
                baseBranch = repo?.let { ui.branch ?: it.defaultBranch },
                environmentId = ui.environmentId,
                model = ui.model,
                effort = ui.effort,
            )
            io { source.create(request) }.fold(
                onSuccess = { session ->
                    store.put("choices:$serverId", json.encodeToString(Remembered(repo, repo?.let { ui.branch }, ui.model)))
                    store.remove("draft:$serverId")
                    _ui.update { it.copy(text = "", busy = false, created = session) }
                },
                onFailure = { e ->
                    if (e is ApiException && e.status == 401) onSignedOut()
                    _ui.update { it.copy(busy = false, failure = e) }
                },
            )
        }
    }

    /** 界面打开了发起的会话以后调用。 */
    fun consumeCreated() = _ui.update { it.copy(created = null) }

    private suspend fun loadRepos() {
        io { source.repos() }.fold(
            { repos ->
                allRepos = repos
                if (_repos.value.query.isBlank()) _repos.update { it.copy(repos = repos, failure = null) }
            },
            { e -> _repos.update { it.copy(failure = e) } },
        )
    }

    private suspend fun loadBranches(repo: Repo) {
        val branches = io { source.branches(repo.fullName) }.getOrNull()
        // 分支很多时可能没列全，保证默认分支一定在里面；拿不到就只有默认分支
        val list = branches?.let { if (repo.defaultBranch in it) it else listOf(repo.defaultBranch) + it } ?: listOf(repo.defaultBranch)
        _ui.update { current ->
            if (current.repo?.fullName != repo.fullName) {
                current
            } else {
                current.copy(branches = list, branch = current.branch?.takeIf { it in list } ?: repo.defaultBranch)
            }
        }
    }

    private suspend fun <T> io(block: () -> T): Result<T> = try {
        Result.success(withContext(Dispatchers.IO) { block() })
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(e)
    }

    private companion object {
        val json = Json { ignoreUnknownKeys = true }
    }
}
