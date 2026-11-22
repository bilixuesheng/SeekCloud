/**
 * 开源声明列出的软件。
 * - DeepSeek Harness 是沙箱里跑的 Agent，按 MIT 许可证的要求放上完整的版权声明和许可文本（ADR 0004）；
 * - 其余是主站和宿主机直接依赖的开源包。licenses.test.ts 检查 package.json 里的每个依赖都在这里，
 *   许可证和包里写的一致，加了依赖忘了更新这里会测试失败。
 */
export interface OpenSourceItem {
  name: string;
  /** 对应的 npm 包，测试用来核对。不是 npm 包的（比如 DeepSeek Harness）为空。 */
  packages: string[];
  license: "MIT" | "Apache-2.0" | "OFL-1.1";
  copyright: string;
  url: string;
  /** 用来做什么。 */
  usage: string;
}

export const OPEN_SOURCE: OpenSourceItem[] = [
  {
    name: "DeepSeek Harness",
    packages: [],
    license: "MIT",
    copyright: "Copyright (c) 2026 DeepSeek",
    url: "https://github.com/deepseek-ai/deepseek-harness",
    usage: "沙箱中运行的 Agent（在其基础上修改）",
  },
  {
    name: "pi-ai（@earendil-works/pi-ai）",
    packages: [],
    license: "MIT",
    copyright: "Copyright (c) Mario Zechner",
    url: "https://github.com/earendil-works/pi",
    usage:
      "第三方模型提供方的目录（设置中“添加模型提供商”列出的提供方和模型，与沙箱中的 DeepSeek Harness 使用同一份）",
  },
  {
    name: "React",
    packages: ["react", "react-dom"],
    license: "MIT",
    copyright: "Copyright (c) Meta Platforms, Inc. and affiliates.",
    url: "https://github.com/facebook/react",
    usage: "网页界面",
  },
  {
    name: "react-markdown",
    packages: ["react-markdown"],
    license: "MIT",
    copyright: "Copyright (c) Espen Hovlandsdal",
    url: "https://github.com/remarkjs/react-markdown",
    usage: "Markdown 渲染",
  },
  {
    name: "remark-gfm",
    packages: ["remark-gfm"],
    license: "MIT",
    copyright: "Copyright (c) Titus Wormer",
    url: "https://github.com/remarkjs/remark-gfm",
    usage: "Markdown 扩展语法（表格、任务列表等）",
  },
  {
    name: "unified 的 HTML 和 Markdown 工具（hast-util-from-html、hast-util-to-mdast、mdast-util-gfm、mdast-util-to-markdown）",
    packages: [
      "hast-util-from-html",
      "hast-util-to-mdast",
      "mdast-util-gfm",
      "mdast-util-to-markdown",
    ],
    license: "MIT",
    copyright: "Copyright (c) Titus Wormer",
    url: "https://github.com/syntax-tree",
    usage: "模型网关的网页抓取：把网页转成 Markdown",
  },
  {
    name: "Workbox",
    packages: [],
    license: "MIT",
    copyright: "Copyright 2018 Google LLC",
    url: "https://github.com/GoogleChrome/workbox",
    usage: "离线缓存（由 vite-plugin-pwa 生成）",
  },
  {
    name: "Noto Serif SC（思源宋体）",
    packages: ["@fontsource/noto-serif-sc"],
    license: "OFL-1.1",
    copyright: "Copyright Google Inc.",
    url: "https://github.com/notofonts/noto-cjk",
    usage: "标题字体",
  },
  {
    name: "Hono",
    packages: ["hono", "@hono/node-server", "@hono/zod-openapi"],
    license: "MIT",
    copyright: "Copyright (c) 2021 - present, Yusuke Wada and Hono contributors",
    url: "https://github.com/honojs/hono",
    usage: "服务端接口",
  },
  {
    name: "Zod",
    packages: ["zod"],
    license: "MIT",
    copyright: "Copyright (c) 2025 Colin McDonnell",
    url: "https://github.com/colinhacks/zod",
    usage: "数据校验",
  },
  {
    name: "fflate",
    packages: ["fflate"],
    license: "MIT",
    copyright: "Copyright (c) 2026 Arjun Barrett",
    url: "https://github.com/101arrowz/fflate",
    usage: "数据导出的 zip 打包",
  },
  {
    name: "uqr",
    packages: ["uqr"],
    license: "MIT",
    copyright: "Copyright (c) Project Nayuki; Copyright (c) 2023 Anthony Fu",
    url: "https://github.com/unjs/uqr",
    usage: "开启两步验证时显示的二维码",
  },
  {
    name: "Drizzle ORM",
    packages: ["drizzle-orm"],
    license: "Apache-2.0",
    copyright: "Copyright Drizzle Team",
    url: "https://github.com/drizzle-team/drizzle-orm",
    usage: "数据库访问",
  },
  {
    name: "node-postgres",
    packages: ["pg"],
    license: "MIT",
    copyright: "Copyright (c) 2010 - 2021 Brian Carlson",
    url: "https://github.com/brianc/node-postgres",
    usage: "PostgreSQL 连接",
  },
  {
    name: "ws",
    packages: ["ws"],
    license: "MIT",
    copyright:
      "Copyright (c) 2011 Einar Otto Stangvik, Copyright (c) 2013 Arnout Kazemier and contributors, Copyright (c) 2016 Luigi Pinca and contributors",
    url: "https://github.com/websockets/ws",
    usage: "主站和宿主机之间的连接（WebSocket）",
  },
];

export const LICENSE_NAMES: Record<OpenSourceItem["license"], string> = {
  MIT: "MIT License",
  "Apache-2.0": "Apache License 2.0",
  "OFL-1.1": "SIL Open Font License 1.1",
};

export const LICENSE_URLS: Record<OpenSourceItem["license"], string> = {
  MIT: "https://opensource.org/license/mit",
  "Apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  "OFL-1.1": "https://openfontlicense.org/open-font-license-official-text/",
};

/** MIT 许可证的正文。版权行在每一项上。 */
export const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
