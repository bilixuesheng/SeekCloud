import { type ComponentType, createContext, type ReactNode, useContext } from "react";

/**
 * 浏览器端的注册表（ADR 0010 第 4 条）：页面、设置分类、插槽都从这里来，不写死在 App 里。
 * main.tsx 先登记主干自己的（trunk.tsx），再挂载应用；下游版本在挂载之前再登记自己的。
 */

/** 地址里的参数，比如会话页的 { id }。 */
export type RouteParams = Record<string, string>;

export interface PageProps {
  params: RouteParams;
}

/** 盖在页面上的弹窗（设置）多拿到这两样：正在关（播收起的动画），以及怎么关。 */
export interface OverlayProps extends PageProps {
  closing: boolean;
  onClose: () => void;
}

export interface PageEntry {
  /** 页面的标识，useRoute() 的 page 就是它。 */
  id: string;
  /** 地址的样式。":名字" 是一段参数，后面带 "?" 的可以没有，比如 "/s/:id"、"/settings/:section?"。 */
  path: string;
  component: ComponentType<PageProps> | ComponentType<OverlayProps>;
  /** 不用登录也能看（开源声明）：不等登录状态，占满整个窗口。默认要登录，画在侧栏右边。 */
  public?: boolean;
  /** 盖在原来页面上的弹窗（设置）：底下照常显示打开它之前的那一页；换页不做过渡，弹窗自己有动画。 */
  overlay?: boolean;
  /** 页面自己有顶栏（会话页）：手机上不显示首页那条顶栏。 */
  ownHeader?: boolean;
}

export interface SettingsSectionProps {
  /** 关联 GitHub 跳回来时出的问题。 */
  notice?: string;
  onSignedOut: () => void;
  onGitHubChanged: () => void;
  /** 改了昵称以后（侧栏底部的名字、首页的问候语跟着变）。 */
  onProfileChanged: () => void;
}

export interface SettingsSectionEntry {
  /** 地址里的那一段：/settings/<id>。 */
  id: string;
  name: string;
  icon: ReactNode;
  component: ComponentType<SettingsSectionProps>;
  /** 排在哪：小的在前。主干的几类是 10、20、30、40，下游插在中间或者放到后面。 */
  order: number;
}

/**
 * 插槽：页面上留出来的几个位置，登记进来的组件按 order 依次显示，没有组件时不占位置。
 * - sidebar-foot：侧栏底部，账户菜单上方；
 * - composer-below：输入框下方，模型按钮那一行；
 * - session-banner：会话页顶部的提示条；
 * - home-below-greeting：首页问候语下方（"有会话在等你输入"的提示放这里）。
 */
export const SLOTS = [
  "sidebar-foot",
  "composer-below",
  "session-banner",
  "home-below-greeting",
] as const;
export type SlotName = (typeof SLOTS)[number];

export interface SlotEntry {
  id: string;
  component: ComponentType;
  order: number;
}

const warn = (message: string) => {
  if (import.meta.env?.DEV) console.warn(`SeekCloud 注册表：${message}`);
};

export class Registry {
  readonly #pages: PageEntry[] = [];
  readonly #sections: SettingsSectionEntry[] = [];
  readonly #slots = new Map<SlotName, SlotEntry[]>();

  /** 登记一个页面。和已有的页面同一个标识或同一个地址时，后登记的盖掉先登记的。 */
  page(entry: PageEntry): this {
    const clash = this.#pages.findIndex((p) => p.id === entry.id || p.path === entry.path);
    if (clash >= 0) {
      warn(`页面 ${entry.id}（${entry.path}）盖掉了先登记的 ${this.#pages[clash]?.id}`);
      this.#pages.splice(clash, 1);
    }
    this.#pages.push(entry);
    return this;
  }

  /** 登记一个设置分类。同一个标识的，后登记的盖掉先登记的。 */
  settings(entry: SettingsSectionEntry): this {
    const clash = this.#sections.findIndex((s) => s.id === entry.id);
    if (clash >= 0) {
      warn(`设置分类 ${entry.id} 盖掉了先登记的`);
      this.#sections.splice(clash, 1);
    }
    this.#sections.push(entry);
    return this;
  }

  /** 往插槽里放一个组件。同一个插槽里同一个标识的，后登记的盖掉先登记的。 */
  slot(name: SlotName, entry: SlotEntry): this {
    const list = (this.#slots.get(name) ?? []).filter((s) => {
      if (s.id !== entry.id) return true;
      warn(`插槽 ${name} 里的 ${entry.id} 盖掉了先登记的`);
      return false;
    });
    this.#slots.set(name, [...list, entry]);
    return this;
  }

  get pages(): readonly PageEntry[] {
    return this.#pages;
  }

  /** 设置分类，按 order 排好。 */
  get settingsSections(): readonly SettingsSectionEntry[] {
    return [...this.#sections].sort((a, b) => a.order - b.order);
  }

  /** 一个插槽里的组件，按 order 排好。 */
  slotEntries(name: SlotName): readonly SlotEntry[] {
    return [...(this.#slots.get(name) ?? [])].sort((a, b) => a.order - b.order);
  }

  pageById(id: string): PageEntry | undefined {
    return this.#pages.find((p) => p.id === id);
  }
}

const RegistryContext = createContext<Registry>(new Registry());

export function RegistryProvider({
  registry,
  children,
}: {
  registry: Registry;
  children: ReactNode;
}) {
  return <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>;
}

export const useRegistry = (): Registry => useContext(RegistryContext);

/** 画出一个插槽里登记的组件；一个都没有时什么都不画。 */
export function Slot({ name }: { name: SlotName }) {
  const entries = useRegistry().slotEntries(name);
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(({ id, component: Component }) => (
        <Component key={id} />
      ))}
    </>
  );
}
