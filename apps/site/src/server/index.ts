// 主站服务端的公开出口（ADR 0010）：下游版本只从这里拿东西，不直接引用里面的文件。
// 包名下的路径是 @seekcloud/site/server，见 package.json 的 exports。

export { type AppDeps, createApp } from "./app";
export { adminIdentity } from "./auth/admin-identity";
export { connectDatabase, type Database } from "./db/client";
export { type MigrationSet, runMigrations, TRUNK_MIGRATIONS } from "./db/migrate";
export * as schema from "./db/schema";
export { createDefaultEnvironment } from "./environments";
export { apiError, errorResponse, notLoggedIn } from "./errors";
export { GatewayError, type GatewayFailure } from "./gateway/failures";
export { ModelGateway } from "./gateway/gateway";
export {
  DEEPSEEK,
  deepseekRouting,
  setProviderKey,
  stripHarnessFields,
  transparentErrors,
  usageAdmission,
} from "./gateway/trunk";
export type { GitHub } from "./github/port";
export { type HostVariables, hostAuth } from "./hosts/credential";
export { HostHub, type HostStatus } from "./hosts/hub";
export type {
  Admission,
  ApiErrorBody,
  Clock,
  CurrentUser,
  ErrorPresentation,
  Identity,
  ModelAdmission,
  ModelCall,
  ModelPurpose,
  ModelUsage,
  ProviderRouting,
  ProviderService,
  ProviderTarget,
  ServiceCall,
  SettingsActor,
  SettingsPolicy,
  UpstreamFailure,
  WebTool,
  WebToolCall,
  WebToolUsage,
} from "./ports";
export { MODEL_PURPOSES, systemClock, WEB_TOOLS } from "./ports";
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
