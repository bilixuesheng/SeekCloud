import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type OverlayProps, Registry, RegistryProvider, SLOTS, Slot } from "./registry";
import { matchPath, pathOf, setPages } from "./router";
import { resolveSection } from "./settings/SettingsDialog";
import { ShellProvider, type ShellValue } from "./shell";
import { registerTrunk } from "./trunk";

const shell: ShellValue = {
  me: { id: "u1", githubLogin: null, nickname: "管理员" },
  sessions: [],
  upsert: () => undefined,
  openDrawer: () => undefined,
  overlayOpen: true,
  onSignedOut: () => undefined,
  onProfileChanged: () => undefined,
};

const render = (registry: Registry, node: React.ReactNode) =>
  renderToStaticMarkup(
    <RegistryProvider registry={registry}>
      <ShellProvider value={shell}>{node}</ShellProvider>
    </RegistryProvider>,
  );

afterEach(() => vi.restoreAllMocks());

const Empty = () => null;

describe("路由表", () => {
  const trunk = registerTrunk(new Registry());

  it("主干的地址照旧：首页、会话页、设置、开源声明；末尾多一个斜杠也认", () => {
    expect(matchPath(trunk.pages, "/")).toEqual({ page: "home", params: {} });
    expect(matchPath(trunk.pages, "/s/k3x9")).toEqual({ page: "session", params: { id: "k3x9" } });
    expect(matchPath(trunk.pages, "/s/k3x9/")).toEqual({ page: "session", params: { id: "k3x9" } });
    expect(matchPath(trunk.pages, "/settings")).toEqual({ page: "settings", params: {} });
    expect(matchPath(trunk.pages, "/settings/github")).toEqual({
      page: "settings",
      params: { section: "github" },
    });
    expect(matchPath(trunk.pages, "/licenses")).toEqual({ page: "licenses", params: {} });
  });

  it("找不到的地址回首页", () => {
    for (const path of ["/nope", "/s/", "/s/a/b", "/settings/a/b", "/%E0%A4%A"]) {
      expect(matchPath(trunk.pages, path), path).toEqual({ page: "home", params: {} });
    }
  });

  it("地址反过来从路由表拼：可以没有的参数没给时那一段不写", () => {
    setPages(trunk.pages);
    expect(pathOf({ page: "home", params: {} })).toBe("/");
    expect(pathOf({ page: "session", params: { id: "k3x9" } })).toBe("/s/k3x9");
    expect(pathOf({ page: "settings", params: {} })).toBe("/settings");
    expect(pathOf({ page: "settings", params: { section: "data" } })).toBe("/settings/data");
  });

  it("同一个标识或同一个地址登记两次：后登记的盖掉先登记的，开发模式下提示一次", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = registerTrunk(new Registry()).page({
      id: "my-home",
      path: "/",
      component: Empty,
    });

    expect(matchPath(registry.pages, "/")).toEqual({ page: "my-home", params: {} });
    expect(registry.pages.filter((p) => p.path === "/")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("下游加的页面可以从地址直接打开", () => {
    const registry = registerTrunk(new Registry()).page({
      id: "billing",
      path: "/billing/:invoice?",
      component: () => null,
    });
    expect(matchPath(registry.pages, "/billing/inv_7")).toEqual({
      page: "billing",
      params: { invoice: "inv_7" },
    });
    expect(matchPath(registry.pages, "/s/k3x9").page).toBe("session");
  });
});

describe("设置分类", () => {
  /** 注册表里的设置弹窗（主干登记成盖在页面上的那一页），打开 /settings/<section>。 */
  const openSettings = (registry: Registry, path: string) => {
    const route = matchPath(registry.pages, path);
    const Settings = registry.pageById(route.page)?.component as ComponentType<OverlayProps>;
    return render(
      registry,
      <Settings params={route.params} closing={false} onClose={() => undefined} />,
    );
  };

  it("主干登记通用、GitHub、账户、数据四类，按顺序排", () => {
    const names = registerTrunk(new Registry()).settingsSections.map((s) => s.name);
    expect(names).toEqual(["通用", "GitHub", "账户", "数据"]);
  });

  it("加一个分类只需要加一项登记：排在登记的位置，能从地址直接打开", () => {
    const registry = registerTrunk(new Registry()).settings({
      id: "usage",
      name: "用量",
      icon: null,
      component: () => <p>本月用量的内容</p>,
      order: 35,
    });

    const html = openSettings(registry, "/settings/usage");

    expect(html).toContain("本月用量的内容");
    // 左栏的每一项：去掉图标，只留名字
    const nav = [...html.matchAll(/<a [^>]*class="settings-nav-item([^"]*)"[^>]*>(.*?)<\/a>/g)].map(
      (m) => `${m[2]?.replace(/<[^>]+>/g, "")}${m[1]?.includes("current") ? "（当前）" : ""}`,
    );
    expect(nav).toEqual(["通用", "GitHub", "账户", "用量（当前）", "数据"]);
  });

  it("地址里的分类不认识或没写时打开账户；下游拿掉了账户时打开排在最前面的", () => {
    const sections = registerTrunk(new Registry()).settingsSections;
    expect(resolveSection(sections, "nope")?.id).toBe("account");
    expect(resolveSection(sections, undefined)?.id).toBe("account");
    expect(resolveSection(sections, "data")?.id).toBe("data");
    expect(
      resolveSection(
        sections.filter((s) => s.id !== "account"),
        "nope",
      )?.id,
    ).toBe("general");
  });
});

describe("插槽", () => {
  it("登记进来的组件按顺序显示；一个都没有时什么都不画", () => {
    const registry = new Registry()
      .slot("home-below-greeting", { id: "b", component: () => <p>第二</p>, order: 20 })
      .slot("home-below-greeting", { id: "a", component: () => <p>第一</p>, order: 10 });

    expect(render(registry, <Slot name="home-below-greeting" />)).toBe("<p>第一</p><p>第二</p>");
    expect(render(registry, <Slot name="sidebar-foot" />)).toBe("");
  });

  it("同一个插槽里同一个标识登记两次，后登记的盖掉先登记的", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = new Registry()
      .slot("session-banner", { id: "x", component: () => <p>旧</p>, order: 10 })
      .slot("session-banner", { id: "x", component: () => <p>新</p>, order: 10 });
    expect(render(registry, <Slot name="session-banner" />)).toBe("<p>新</p>");
  });

  it("四个插槽在页面上都放好了位置", async () => {
    const dir = import.meta.dirname;
    const files = await readdir(dir, { recursive: true });
    const sources = await Promise.all(
      files
        .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx") && f !== "registry.tsx")
        .map((f) => readFile(join(dir, f), "utf8")),
    );
    for (const name of SLOTS) {
      expect(
        sources.some((s) => s.includes(`<Slot name="${name}" />`)),
        name,
      ).toBe(true);
    }
  });
});
