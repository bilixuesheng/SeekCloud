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

  // "连接服务器"页（#204）
  connect_title: "连接服务器",
  connect_hint: "输入{brand}主站的地址，例如 seekcloud.example.com。",
  connect_address: "服务器地址",
  connect_button: "连接",
  connect_connecting: "正在连接…",
  connect_connected: "已连接至 {host}",
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
} as const satisfies Record<string, string>;
