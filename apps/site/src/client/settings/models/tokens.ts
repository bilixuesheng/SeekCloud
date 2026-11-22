/**
 * 上下文窗口、最大输出这类 token 数的写法（2026-11-22 用户说直接填 1000000 反人类）：
 * 输入框里可以写 128K、1M、1.5M、12.8万、131072、131,072，存的还是整数；显示时写成最短的、能原样读回来的样子。
 * K、M 是十进制（1M = 1000K），和模型厂商公布容量的写法一样（dsh 也是这样）。
 */

const PATTERN = /^(\d+(?:\.\d+)?)\s*(k|m|万)?$/i;
const SCALE = { k: 1_000, m: 1_000_000, 万: 10_000 } as const;

/** 读一个 token 数。空的为 undefined（不填），写法不对为 NaN。 */
export function parseTokens(text: string): number | undefined {
  const trimmed = text.trim().replace(/[,，_\s]/g, "");
  if (!trimmed) return undefined;
  const match = PATTERN.exec(trimmed);
  if (!match) return Number.NaN;
  const unit = match[2]?.toLowerCase() as keyof typeof SCALE | undefined;
  const value = Number(match[1]) * (unit ? SCALE[unit] : 1);
  // 2.3M 这类小数倍在二进制里差一点点，按整数读
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-6 ? rounded : Number.NaN;
}

/** 输入框里的写法：整千、整百万的写成 K、M，别的写全（读回来一模一样）。 */
export function tokenInputText(value: number | null | undefined): string {
  if (!value) return "";
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value % 1_000 === 0) return `${value / 1_000}K`;
  return String(value);
}

/** 简短的写法（列表、标签上用）：三位有效数字，比如 131K、1.05M、200K、64K。 */
export function shortTokens(value: number): string {
  const fmt = (n: number) => String(Number(n.toPrecision(3)));
  if (value >= 1_000_000) return `${fmt(value / 1_000_000)}M`;
  if (value >= 1_000) return `${fmt(value / 1_000)}K`;
  return String(value);
}

/** 完整的写法：131,072。 */
export const fullTokens = (value: number) => value.toLocaleString("en-US");

/** 常见的上下文窗口、最大输出，输入框下面一排点一下就填上。 */
export const CONTEXT_PRESETS = [32_000, 128_000, 200_000, 256_000, 1_000_000];
export const OUTPUT_PRESETS = [8_000, 32_000, 64_000, 128_000];

/** 价格：每百万 token 多少美元。整数写 $15，别的写两位小数 $0.30，很小的留两位有效数字 $0.055。 */
export function priceText(value: number): string {
  if (Number.isInteger(value)) return `$${value}`;
  if (value < 0.1) return `$${Number(value.toPrecision(2))}`;
  return `$${value.toFixed(2)}`;
}

/** 一对价格写成一样的格式：都是整数时 $3 / $15，不然都写两位小数 $0.30 / $1.00（很小的照 priceText）。 */
export function pricePair(cost: [number, number]): [string, string] {
  if (cost.every((n) => Number.isInteger(n))) return [`$${cost[0]}`, `$${cost[1]}`];
  const one = (n: number) => (n > 0 && n < 0.1 ? priceText(n) : `$${n.toFixed(2)}`);
  return [one(cost[0]), one(cost[1])];
}

/** 一个模型的价格：输入 $0.30 / 输出 $1.20。 */
export function costText(cost: [number, number]): string {
  const [input, output] = pricePair(cost);
  return `输入 ${input} / 输出 ${output}`;
}
