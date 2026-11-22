/**
 * 简体中文的文案目录，是基准：英文目录（en.ts）的键必须和它完全一样，少了、多了都过不了类型检查。
 *
 * 写法：
 * - 键按页面分组，用点隔开（login.title）；
 * - {名字} 是插值，调用时传进来；{brand} 不用传，自动换成品牌名（这一份里的 brand.name）；
 * - 中文不分单复数，英文要分的在 en.ts 里写成 { one, other }，按 {count} 选；
 * - 文案照 docs/brand/README.md 的"界面文案规范"写。
 *
 * 2026-11-18 定的：中文界面处处用中文名"云上求索"，品牌名只在这里写一次，别的文案引用它。
 */
export const zh = {
  "brand.name": "云上求索",
  "brand.tagline": "代码无界，智能随行",
  "brand.notOfficial": "非 DeepSeek 官方产品",

  "common.cancel": "取消",
  "common.close": "关闭",
  "common.back": "返回",
  "common.pleaseWait": "请稍候…",

  "legal.licenses": "开源声明",

  "language.auto": "跟随浏览器",
  "language.switch": "切换界面语言",

  "login.title": "登录",
  "login.password": "密码",
  "login.submit": "登录",
  "login.passkey": "使用通行密钥登录",
  "login.forgot": "忘记密码时，可在服务器的 apps/site 目录中运行 {command} 重置。",
  "setup.title": "首次设置",
  "setup.hint": "请设置昵称和管理员密码。昵称是{brand}称呼你时使用的名字，之后可在设置中修改。",
  "setup.nickname": "昵称",
  "setup.newPassword": "新密码（至少 8 位）",
  "setup.confirmPassword": "确认密码",
  "setup.mismatch": "两次输入的密码不一致。",
  "setup.submit": "设置密码并登录",
  "twoFactor.title": "两步验证",
  "twoFactor.enterCode": "请输入验证器 App 中显示的 6 位验证码。",
  "twoFactor.enterRecovery": "请输入一个恢复码。每个恢复码只能使用一次。",
  "twoFactor.code": "验证码",
  "twoFactor.recoveryCode": "恢复码",
  "twoFactor.submit": "验证并登录",
  "twoFactor.useCode": "使用验证码",
  "twoFactor.useRecovery": "使用恢复码",
  "twoFactor.recoveryHelp":
    "恢复码也无法使用时，可在服务器的 apps/site 目录中运行 {command}，同时关闭两步验证。",

  "passkey.cancelled": "验证已取消，或未在规定时间内完成。",
  "passkey.exists": "此设备上已有该账户的通行密钥。",
  "passkey.failed": "通行密钥验证失败，请重试。",

  "error.network": "网络异常，请稍后重试。",
  "error.wrong_password": "密码错误。",
  "error.wrong_code": "验证码错误。",
  "error.login_expired": "登录已超时，请重新输入密码。",
  "error.rate_limited": "操作过于频繁，请 {count} 秒后重试。",
  "error.already_set_up": "已设置管理员密码，请直接登录。",
  "error.passkey_invalid": "通行密钥验证失败，请重试。",

  "settings.title": "设置",
  "settings.windowTitle": "设置 · {brand}",
  "settings.nav": "设置分类",
  "settings.section.general": "通用",
  "settings.section.model": "模型",
  "settings.section.sessions": "会话",
  "settings.section.github": "GitHub",
  "settings.section.account": "账户",
  "settings.section.data": "数据",

  "general.appearance": "外观",
  "general.theme.light": "浅色",
  "general.theme.dark": "深色",
  "general.theme.system": "跟随系统",
  "general.effort": "默认思考强度",
  "general.effortHint":
    "新会话默认使用这一档；所选模型没有这一档时，用它最接近的一档。已有的会话不受影响。",
  "general.language": "语言",
  "general.languageHint": "界面使用的语言。Agent 回复时使用你提问的语言，不受此设置影响。",

  "effort.off": "关闭",
  "effort.minimal": "极低",
  "effort.low": "低",
  "effort.medium": "中",
  "effort.high": "高",
  "effort.xhigh": "很高",
  "effort.max": "最高",

  "time.justNow": "刚刚",
  "time.minutesAgo": "{count} 分钟前",
  "time.hoursAgo": "{count} 小时前",
  "time.daysAgo": "{count} 天前",
  "time.today": "今天 {time}",
  "time.yesterday": "昨天 {time}",
} as const satisfies Record<string, string>;
