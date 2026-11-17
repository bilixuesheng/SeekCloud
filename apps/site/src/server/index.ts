// 主站服务端的公开出口（ADR 0010）：下游版本只从这里拿东西，不直接引用里面的文件。
// 包名下的路径是 @seekcloud/site/server，见 package.json 的 exports。

export { type AppDeps, createApp } from "./app";
export { adminIdentity } from "./auth/admin-identity";
export { connectDatabase, type Database } from "./db/client";
export { type MigrationSet, runMigrations, TRUNK_MIGRATIONS } from "./db/migrate";
export * as schema from "./db/schema";
export { createDefaultEnvironment } from "./environments";
export { apiError, errorResponse, notLoggedIn } from "./errors";
export type { GitHub } from "./github/port";
export type {
  ApiErrorBody,
  Clock,
  CurrentUser,
  Identity,
  SettingsActor,
  SettingsPolicy,
} from "./ports";
export { systemClock } from "./ports";
export { jsonBody, newRouter } from "./routes/router";
export { SecretBox } from "./secrets";
export type { HostLink } from "./sessions/host";
export {
  adminSettings,
  readSetting,
  SETTINGS,
  type SettingKey,
  type SettingValue,
  writeSetting,
} from "./settings";
