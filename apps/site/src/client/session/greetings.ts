/**
 * 新会话页的问候语：每次打开随机挑一句。
 * 有几句看时间（按浏览器的当地时间）和是不是周末。
 */
export function pickGreeting(now = new Date(), random = Math.random): string {
  const hour = now.getHours();
  const pool = [
    "今日有何计划？",
    "从何处着手？",
    "请描述你的任务",
    "欢迎回来",
    "路漫漫其修远兮",
    "吾将上下而求索",
  ];
  if (hour >= 5 && hour < 11) pool.push("早上好", "新的一天，从何开始？");
  else if (hour >= 11 && hour < 14) pool.push("中午好");
  else if (hour >= 14 && hour < 18) pool.push("下午好");
  else if (hour >= 18 && hour < 23) pool.push("晚上好");
  else pool.push("夜深了，注意休息", "夜深，仍在求索");
  if (now.getDay() === 0 || now.getDay() === 6) pool.push("周末愉快");
  return pool[Math.floor(random() * pool.length)] ?? "今日有何计划？";
}
