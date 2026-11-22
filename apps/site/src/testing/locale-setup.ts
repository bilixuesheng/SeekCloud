import { resetForTests } from "../client/i18n";

// 测试跑在 Node 里，浏览器语言是英文；界面的测试按中文断言（规格 #134 的测试决定：固定用中文跑）。
// 要测英文的在测试里自己 resetForTests("en")。
resetForTests("zh-CN");
