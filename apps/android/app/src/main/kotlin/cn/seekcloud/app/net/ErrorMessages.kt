// 由 apps/site/src/client/i18n/android.ts 从文案目录生成，不要手改；重新生成的命令是 apps/site/package.json 里的 android:strings
package cn.seekcloud.app.net

import cn.seekcloud.app.R

/** 主站接口的报错码（`{ error: { code } }`）对应的文案，和网页上的说法一样。 */
internal val ERROR_MESSAGES: Map<String, Int> = mapOf(
    "network" to R.string.error_network,
    "wrong_password" to R.string.error_wrong_password,
    "wrong_code" to R.string.error_wrong_code,
    "login_expired" to R.string.error_login_expired,
    "already_set_up" to R.string.error_already_set_up,
    "passkey_invalid" to R.string.error_passkey_invalid,
    "already_enabled" to R.string.error_already_enabled,
    "body_too_large" to R.string.error_body_too_large,
    "code_required" to R.string.error_code_required,
    "device_not_found" to R.string.error_device_not_found,
    "export_not_found" to R.string.error_export_not_found,
    "forbidden" to R.string.error_forbidden,
    "github_unavailable" to R.string.error_github_unavailable,
    "internal_error" to R.string.error_internal_error,
    "invalid_request" to R.string.error_invalid_request,
    "model_error_not_found" to R.string.error_model_error_not_found,
    "not_enabled" to R.string.error_not_enabled,
    "not_found" to R.string.error_not_found,
    "not_linked" to R.string.error_not_linked,
    "passkey_not_found" to R.string.error_passkey_not_found,
    "request_failed" to R.string.error_request_failed,
    "setting_locked" to R.string.error_setting_locked,
    "setup_expired" to R.string.error_setup_expired,
    "setup_required" to R.string.error_setup_required,
    "catalog_not_found" to R.string.error_catalog_not_found,
    "provider_builtin" to R.string.error_provider_builtin,
    "provider_exists" to R.string.error_provider_exists,
    "provider_not_found" to R.string.error_provider_not_found,
    "invalid_models" to R.string.error_invalid_models,
    "probe_failed" to R.string.error_probe_failed,
    "unauthorized" to R.string.error_unauthorized,
    "github_not_connected" to R.string.error_github_not_connected,
    "repo_not_found" to R.string.error_repo_not_found,
    "branch_not_found" to R.string.error_branch_not_found,
    "environment_not_found" to R.string.error_environment_not_found,
    "model_not_found" to R.string.error_model_not_found,
    "model_gone" to R.string.error_model_gone,
    "model_not_configured" to R.string.error_model_not_configured,
    "session_not_found" to R.string.error_session_not_found,
    "session_closed" to R.string.error_session_closed,
    "queued_not_found" to R.string.error_queued_not_found,
    "nothing_running" to R.string.error_nothing_running,
    "session_archived" to R.string.error_session_archived,
    "message_not_found" to R.string.error_message_not_found,
    "group_not_found" to R.string.error_group_not_found,
    "too_many_groups" to R.string.error_too_many_groups,
    "invalid_group_name" to R.string.error_invalid_group_name,
)

/** 带秒数的报错（Retry-After），按数量选单复数。 */
internal val ERROR_PLURALS: Map<String, Int> = mapOf(
    "rate_limited" to R.plurals.error_rate_limited,
)
