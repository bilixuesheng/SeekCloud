import type { Session, SessionGroup } from "@seekcloud/protocol";
import { createContext, useContext } from "react";

export interface Me {
  id: string;
  /** 关联的 GitHub 用户名；没关联时为 null。 */
  githubLogin: string | null;
  /** 昵称：SeekCloud 称呼管理员时用的名字（侧栏、问候语）；加上昵称之前就设置好的部署是 null。 */
  nickname: string | null;
}

/** 登录后的外壳（侧栏加主区域）给里面的页面用的东西。注册表里登记的页面从这里拿，不靠 App 传参数。 */
export interface ShellValue {
  me: Me;
  /** 关联 GitHub 跳回来时出的问题。 */
  notice?: string;
  /** 侧栏里的会话列表。 */
  sessions: Session[];
  /** 侧栏的分组（#153），按顺序。 */
  groups: SessionGroup[];
  /** 新建或更新了一个会话，先放进侧栏，不等列表的事件流。 */
  upsert: (session: Session) => void;
  /** 手机上打开会话列表（会话页自己的顶栏用）。 */
  openDrawer: () => void;
  /** 盖在页面上的弹窗（设置）开着没有。 */
  overlayOpen: boolean;
  onSignedOut: () => void;
  /** 关联、取消关联 GitHub，或者改了昵称以后：重新拉一遍管理员的资料。 */
  onProfileChanged: () => void;
}

const ShellContext = createContext<ShellValue | null>(null);

export const ShellProvider = ShellContext.Provider;

export function useShell(): ShellValue {
  const value = useContext(ShellContext);
  // 不是界面文案：程序用错时抛的错
  if (!value) throw new Error("useShell 只能用在登录后的页面里");
  return value;
}
