/**
 * 安卓 App 的文案（#204，规格 #122）：中文是基准，app-en.ts 的键必须一样。
 * App 构建不读这里：apps/android 的 strings.xml 由 android.ts 从这两份生成，改了这里要重新生成：
 * 在仓库根目录运行 pnpm --filter @seekcloud/site android:strings（没重新生成时主站的测试失败）。
 *
 * 键就是 App 里的资源名（R.string.connect_title），只用小写字母、数字和下划线。
 * 写法和网页的目录一样：{名字} 插值（App 里按这一份里第一次出现的顺序传参数），{brand} 换成品牌名，
 * 英文分单复数写 { one, other }。照 docs/brand/README.md 的"界面文案规范"写。
 */
export const appZh = {
  app_name: "{brand}",
  cancel: "取消",
  back: "返回",

  // "连接服务器"页（#204）
  connect_title: "连接服务器",
  connect_hint: "输入{brand}主站的地址，例如 seekcloud.example.com。",
  connect_address: "服务器地址",
  connect_button: "连接",
  connect_connecting: "正在连接…",
  connect_invalid: "地址格式无效。请输入域名或 IP 地址，可以带端口。",
  connect_unreachable: "无法连接到该地址。请检查地址和网络后重试。",
  connect_not_seekcloud: "该地址上没有{brand}主站。请检查地址是否正确。",
  connect_unavailable: "{brand}主站暂时不可用，请稍后重试。",
  connect_tls_failure: "无法与该服务器建立安全连接。",
  connect_app_too_old: "该主站要求 App 版本不低于 {version}，请先更新 App。",
  connect_cleartext_title: "连接未加密",
  connect_cleartext_body:
    "该地址使用 HTTP，连接未加密，同一网络中的人能看到你的密码和代码。请只在可信的内网中这样连接。",
  connect_cleartext_confirm: "仍然连接",
  connect_cert_title: "证书不受信任",
  connect_cert_body:
    "该服务器的证书不受系统信任，可能是自签证书。请确认下面的指纹与服务器上的证书一致后再继续。",
  connect_cert_changed_title: "证书已更改",
  connect_cert_changed_body:
    "该服务器的证书与上次确认的不同。如果服务器没有更换证书，连接可能已被拦截。请确认新证书的指纹后再继续。",
  connect_cert_fingerprint: "SHA-256 指纹",
  connect_cert_trust: "信任此证书",
  connect_edit_title: "修改服务器地址",
  connect_edit_hint: "输入{brand}主站的新地址。此设备的登录状态会保留。",
  connect_move_title: "沿用登录状态",
  connect_move_body:
    "新地址 {host} 将沿用此设备在原地址的登录状态。请确认新地址是同一台{brand}主站；如果不是，请取消，并在原地址退出登录。",
  connect_move_confirm: "继续",

  // 登录（#205）
  login_title: "登录",
  login_server: "登录到 {host}",
  login_password: "管理员密码",
  login_button: "登录",
  login_signing_in: "正在登录…",
  login_signed_out: "此设备已退出登录，请重新登录。",
  login_setup_required: "该主站尚未设置管理员密码。请先在浏览器中打开主站，完成首次设置后再登录。",
  login_open_browser: "在浏览器中打开",
  login_check_again: "重新检查",
  login_code_title: "两步验证",
  login_code_hint: "输入身份验证器中的 6 位验证码，或一个恢复码。",
  login_code: "验证码",
  login_verify: "验证",
  login_verifying: "正在验证…",
  switch_server: "更换服务器",

  // 会话列表（#124）：分类的名字、空白页、状态的说法用网页目录里的（sidebar_*、session_list_*、status_*）
  sessions_offline: "连接已断开，正在重连…",
  sessions_more: "更多选项",
  sessions_clear_search: "清除搜索",
  sessions_expand: "展开",
  sessions_collapse: "收起",
  sign_out: "退出登录",
  sign_out_title: "退出登录",
  sign_out_body: "此设备将退出 {host} 的登录。",

  // 服务器列表（#205）
  servers_title: "服务器",
  servers_add: "添加服务器",
  servers_current: "当前使用",
  servers_signed_in: "已登录",
  servers_signed_out: "未登录",
  servers_remove: "删除",
  servers_remove_title: "删除服务器",
  servers_remove_body: "将从此设备删除 {host}，并退出该服务器的登录。",

  // 主站连不上（#205）
  offline_title: "无法连接到主站",
  offline_retry: "重试",
  offline_retrying: "正在重试…",
  offline_edit_address: "修改地址",

  // 主站要求更高的 App 版本（#205）
  update_title: "需要更新 App",
  update_body: "{host} 要求 App 版本不低于 {version}，当前版本为 {current}。请下载新版本后再连接。",
  update_download: "下载新版本",

  // 会话页（#182）：回复里的链接先确认再交给浏览器
  link_open_title: "打开链接",
  link_open_body: "将在浏览器中打开以下地址：",
  link_open_confirm: "打开",
} as const satisfies Record<string, string>;
