// 主站测试工具的公开出口（ADR 0010）：下游版本的测试从这里拿。包名下的路径是 @seekcloud/site/testing。

export { createTestDatabase } from "./database";
export { EventStreamReader, type StreamedEvent } from "./event-stream";
export { FakeGitHub } from "./fake-github";
export { FakeHost } from "./fake-host";
export { FakeIdentity } from "./fake-identity";
export { FakeClock } from "./fakes";
export { describeIdentityContract, type IdentityDriver } from "./identity-contract";
export { createTestApp, type TestApp, type TestAppOptions } from "./test-app";
export { TestBrowser } from "./test-browser";
