// 主站依赖的外部能力和扩展点（ADR 0010）。测试里换成 src/testing 里的假实现。
//
// 扩展点：下游版本可以换掉的东西。每个扩展点在 AppDeps 里占一项，主干里只有单管理员的那一份实现，
// 主干自己在用。主干里不放下游的实现，也不放版本开关。

import type { Context, Env, Hono } from "hono";
import type { SettingKey, SettingValue } from "./settings";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** 接口出错时的返回体，见 errors.ts 的 apiError()。 */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** 发出这个请求的人。 */
export interface CurrentUser {
  /** users 表里的 ID。属于这个人的数据都按它过滤。 */
  id: string;
}

/**
 * 扩展点：身份来源。主干的实现是管理员密码登录（auth/admin-identity.ts）。
 *
 * 所有接口都经过它判断"这个请求是谁的"，自己不读登录状态。身份来源给的 ID 必须是 users 表里的一行：
 * 会话、环境、导出这些数据都挂在它下面。
 */
export interface Identity {
  /** 这个请求是谁的；没登录、登录状态过期或已退出时返回 undefined。 */
  currentUser(c: Context): Promise<CurrentUser | undefined>;
  /**
   * 没登录时 /api/me 回给浏览器的错误，浏览器按错误码决定显示哪个页面。
   * 主干在还没设置管理员时回 setup_required（显示首次设置），其余时候回 unauthorized（显示登录）。
   */
  loggedOut(c: Context): Promise<ApiErrorBody>;
  /**
   * 登录相关的接口，挂在 /api/auth 下面：首次设置、登录、改密码、退出这些。
   * 用 routes/router.ts 的 newRouter() 建的，会出现在接口文档（/api/openapi.json）里。
   */
  routes: Hono<Env>;
}

/** 在读写设置的人。 */
export interface SettingsActor {
  userId: string;
}

/**
 * 扩展点：设置的读写规则。全站设置（settings 表）的每一项，默认值是什么、这个人现在能不能改。
 * 主干的实现在 settings.ts 的 adminSettings：默认值照 settings.ts 写的，管理员都能改。
 */
export interface SettingsPolicy {
  /** 一项设置没改过（库里没有这一行，或者存的值不合现在的形状）时的值。 */
  defaultValue<K extends SettingKey>(
    key: K,
    actor: SettingsActor,
  ): SettingValue<K> | Promise<SettingValue<K>>;
  /** 这个人现在能不能改这一项。不能改时接口回 403 setting_locked。 */
  canWrite(key: SettingKey, actor: SettingsActor): boolean | Promise<boolean>;
}
