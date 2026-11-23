# 品牌

- **名字**：英文名 SeekCloud。原来暂定的中文名"云上求索"在 2026-11-05 去掉了，因为它和 DeepSeek 的公司中文名"深度求索"太像，可能有法律纠纷。2026-11-14 用户定了：本仓库（开源、自部署版）可以用"云上求索"这个中文名，正式的名字仍然以 SeekCloud 为主。
- **标志**：一只坐在云上的小鲸鱼，头顶一颗蓝色的闪光。原图是 `whale-on-cloud-source.webp`（1254×1254，透明背景），用户用图像模型按下面的提示词生成。鲸鱼的造型和颜色故意和 DeepSeek 的标志区分开：我们是独立的第三方，不能让人误以为是官方产品。
  - 2026-11-01 用户要求整体改成 DeepSeek 式的淡蓝色调，不要 Claude 的暖黄色。原图里暖色的部分（象牙白的肚子、暖灰的云朵底色、朱砂色的闪光）按色相换成了冷色，鲸鱼身体的墨蓝没动。
- **颜色**：
  - 强调蓝 `#4566F5`（深色模式 `#4D6BFE`，就是 DeepSeek 的蓝）：按钮、链接、选中、进行中的动画。浅色模式比 DeepSeek 的蓝深一点，白字的对比度才够；
  - 淡蓝 `#EAF0FF`、`#E8EEFE`、`#F3F6FE`：大面积用的底色（"新会话"按钮、用户消息、侧边栏）；
  - 墨蓝 `#283060`：鲸鱼的身体；
  - 天光 `#DDE7FF`：登录页和首页标志后面那团淡淡的光；
  - 应用图标的底色：从上到下 `#C4D4FF` 渐变到 `#ECF1FF`，像天空。
  - 界面里所有颜色都是 `apps/site/src/client/styles.css` 开头的变量，浅色和深色各一套。
- **导出的文件**（在 `apps/site/public/`）：
  - `icons/icon-192.png`、`icons/icon-512.png`：圆角天蓝底，PWA 用；
  - `icons/maskable-512.png`：满版天蓝底，内容在中间 62% 的安全区里，安卓自适应图标用；
  - `apple-touch-icon.png`：180×180 满版，iOS 添加到主屏幕用；
  - `favicon-32.png`、`favicon-16.png`：浏览器标签页；
  - `brand/whale.webp`：透明背景的标志，页面里用。
- **会动的鲸鱼**（`apps/site/src/client/brand/whale-{base,tail,sparkle}.webp`，`Whale.tsx` 用）：只在会话页底部用，32 像素左右；首页和登录页还是原图（`Logo.tsx`），从首页进会话时原图缩小、移到会话底部以后才开始游。原图拆成三层，128×128 无损，叠在一起和原图一样。拆法：在 1254×1254 的原图上，闪光是从 (420, 240) 起连通的不透明像素；尾巴是从 (1100, 420) 起、y < 545 的连通像素；尾巴层再多带一截尾柄（y 545–590 里 alpha ≥ 245 的像素，四周往里收 6 像素），和身体重叠，摆动时接缝不露，又不会盖住尾柄的描边。尾巴绕尾柄 (1007, 575) 摆动，闪光绕 (420, 240) 闪。换标志时照这个重新拆。
- 换标志时，用原图重新导出这些文件（裁掉透明边、放到正方形里，再按上面的比例缩放）。

## 标语

**代码无界，智能随行。**（2026-11-04 定）用在登录页标志和名字下方、网页描述和 PWA 清单。原来的"在云端让 Agent 改你的代码，手机上也能用"用户觉得太口语，不够大气。

## 界面文案规范

2026-11-02 用户要求：页面上的文字不能口语化。界面、给用户看的错误提示、邮件、用户协议和隐私政策都照下面写。

- **书面语，简洁、准确、克制。** 陈述事实和操作结果，不寒暄、不调侃、不反问。
- **称呼用"你"，不用"您"**，和 DeepSeek 一致。
- **不用口语词**：
  - "不对"写成"错误"或"无效"；
  - "没成功""没发出去"写成"失败"；
  - "连不上""用不了""建不了"写成"无法连接""不可用""无法创建"；
  - "还没"写成"尚未"，"已经"写成"已"，"这个"写成"该"或"此"，"以后"写成"此后"或"后"；
  - "好了""一下""看看""想一想""弄""搞"之类一律不用。
- **按钮**用动宾短语："发送验证码""导出数据""永久删除账户"。
- **状态**用"正在……"和"已……"："正在打包""已发送至 x"。
- **错误提示**说清发生了什么，再说怎么办："验证码错误或已过期，请重新获取。""操作过于频繁，请 30 秒后重试。"
- **说明文字**一两句话讲清作用或后果，不解释实现细节。
- 数字和中文之间加空格（"10 分钟""6 位"）；标点用全角，省略号用"…"。
- 新会话页的问候语可以有文采（"路漫漫其修远兮"），但不能俏皮（不写"周末也在折腾？"这类）。
- 例外：Agent 回复里的内容是模型生成的，不受这条约束；回复下方的"DeepSeek 是 AI 并且可能会犯错。"这句是用户指定的原文（2026-11-08），不改；Agent 工作时的状态写"深度求索中"（2026-11-08 用户指定）。

### 英文

界面文案中英两份，写在 `apps/site/src/client/i18n/` 的文案目录里（`zh.ts` 是基准，`en.ts` 的键必须一样，#135）。英文照下面写：

- **简洁、克制**，陈述事实和结果，不寒暄（不写"Oops!""Great!"）。
- **句子式大小写**：只有第一个词和专有名词首字母大写。按钮写"Export data"，不写"Export Data"；标题、标签页、菜单项也一样。
- **称呼用"you"**，不用"the user"；不用感叹号。
- **按钮用动词开头**："Sign in""Add model""Delete provider"。
- **错误提示**先说发生了什么，再说怎么办："Incorrect code.""Too many attempts. Try again in 30 seconds."
- **单复数**：数量会变的写成 `{ one, other }`（"1 minute ago""5 minutes ago"），不写"minute(s)"。
- **数字和单位**按英文习惯（"8 characters""128K tokens"），标点用半角，省略号用"…"（一个字符，和中文一样）。
- **品牌名**：英文界面用 SeekCloud，中文界面用"云上求索"（2026-11-18 定的）；文案里用 `{brand}`，不写死。
- **固定的说法**：回复下方的提示写"DeepSeek is AI and can make mistakes."；Agent 工作时的状态写"Seeking…"（照中文原文译的，规格 #134）。默认环境写"Default"（照 Claude Code 的叫法，中文是"默认环境"）。
- **问候语**另写一套，不直译中文的；可以有文采，不能俏皮。
- **术语对照**：`GLOSSARY.md` 里每个术语后面括号里的英文就是界面上用的英文（Session、Turn、Sandbox、Environment、Provider、Usage……），不另起名字；界面上首字母不大写（"Start a session"），专有名词除外。

## 生成标志用的提示词

```text
Flat vector app icon, 1024x1024, transparent background.
An original, cute, chubby little whale gliding just above a soft round white cloud, side view, gentle smile, small pectoral fin, tail flukes curled upward, a tiny water spout shaped like a four-pointed sparkle.
Minimalist geometric shapes, bold clean silhouette, no outlines, flat colors with at most one very subtle gradient.
Palette: whale in deep ink indigo (#2B3A67) with a pale blue belly (#E2E9FA), cloud pure white with a soft light-blue underside (#D6E0F7), one small bright blue accent (#4D6BFE) on the sparkle only.
Centered, the whale and cloud together fill about 70% of the canvas, must stay recognizable at 32px.
No text, no letters, no watermark. Original design: the whale must NOT resemble the DeepSeek logo or any existing company logo.
```
