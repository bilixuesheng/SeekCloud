import type { Catalog } from "./catalog";

/**
 * English catalog. Its type requires exactly the keys of the Chinese catalog (zh.ts): a missing or extra key
 * fails the type check. Copy follows the English guidelines in docs/brand/README.md: concise, sentence case,
 * "you", no exclamation marks, buttons start with a verb, errors say what happened and then what to do.
 */
export const en: Catalog = {
  "brand.name": "SeekCloud",
  "brand.tagline": "Code without bounds, intelligence at your side",
  "brand.notOfficial": "Not an official DeepSeek product",

  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.back": "Back",
  "common.pleaseWait": "Please wait…",

  "legal.licenses": "Open-source notices",

  "language.auto": "Use browser language",
  "language.switch": "Change interface language",

  "login.title": "Sign in",
  "login.password": "Password",
  "login.submit": "Sign in",
  "login.passkey": "Sign in with a passkey",
  "login.forgot":
    "If you forgot the password, run {command} in apps/site on the server to reset it.",
  "setup.title": "Set up",
  "setup.hint":
    "Choose a nickname and the administrator password. {brand} uses the nickname to address you; you can change it later in Settings.",
  "setup.nickname": "Nickname",
  "setup.newPassword": "New password (at least 8 characters)",
  "setup.confirmPassword": "Confirm password",
  "setup.mismatch": "The passwords do not match.",
  "setup.submit": "Set password and sign in",
  "twoFactor.title": "Two-step verification",
  "twoFactor.enterCode": "Enter the 6-digit code shown in your authenticator app.",
  "twoFactor.enterRecovery": "Enter a recovery code. Each recovery code works once.",
  "twoFactor.code": "Code",
  "twoFactor.recoveryCode": "Recovery code",
  "twoFactor.submit": "Verify and sign in",
  "twoFactor.useCode": "Use a code",
  "twoFactor.useRecovery": "Use a recovery code",
  "twoFactor.recoveryHelp":
    "If no recovery code works, run {command} in apps/site on the server. This also turns off two-step verification.",

  "passkey.cancelled": "Verification was canceled or timed out.",
  "passkey.exists": "This device already has a passkey for this account.",
  "passkey.failed": "Passkey verification failed. Try again.",

  "error.network": "Network error. Try again later.",
  "error.wrong_password": "Incorrect password.",
  "error.wrong_code": "Incorrect code.",
  "error.login_expired": "Sign-in timed out. Enter your password again.",
  "error.rate_limited": {
    one: "Too many attempts. Try again in {count} second.",
    other: "Too many attempts. Try again in {count} seconds.",
  },
  "error.already_set_up": "The administrator password is already set. Sign in instead.",
  "error.passkey_invalid": "Passkey verification failed. Try again.",

  "settings.title": "Settings",
  "settings.windowTitle": "Settings · {brand}",
  "settings.nav": "Settings categories",
  "settings.section.general": "General",
  "settings.section.model": "Models",
  "settings.section.sessions": "Sessions",
  "settings.section.github": "GitHub",
  "settings.section.account": "Account",
  "settings.section.data": "Data",

  "general.appearance": "Appearance",
  "general.theme.light": "Light",
  "general.theme.dark": "Dark",
  "general.theme.system": "Match system",
  "general.effort": "Default thinking effort",
  "general.effortHint":
    "New sessions start at this level. If the chosen model lacks it, the closest level is used. Existing sessions are not affected.",
  "general.language": "Language",
  "general.languageHint":
    "The language of the interface. The Agent replies in the language you write in, regardless of this setting.",

  "effort.off": "Off",
  "effort.minimal": "Minimal",
  "effort.low": "Low",
  "effort.medium": "Medium",
  "effort.high": "High",
  "effort.xhigh": "Extra high",
  "effort.max": "Max",

  "time.justNow": "Just now",
  "time.minutesAgo": { one: "{count} minute ago", other: "{count} minutes ago" },
  "time.hoursAgo": { one: "{count} hour ago", other: "{count} hours ago" },
  "time.daysAgo": { one: "{count} day ago", other: "{count} days ago" },
  "time.today": "Today {time}",
  "time.yesterday": "Yesterday {time}",
};
