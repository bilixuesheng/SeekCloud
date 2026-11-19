// 主站测试工具的公开出口（ADR 0010）：下游版本的测试从这里拿。包名下的路径是 @seekcloud/site/testing。

// 在别的包的测试里用 createTestApp（比如宿主机的端到端测试）：先 createTemplateDatabase，最后 dropTemplateDatabase
// （主站自己的测试由 vitest 的全局准备做，global-setup.ts）
export { createTemplateDatabase, createTestDatabase, dropTemplateDatabase } from "./database";
export { EventStreamReader, type StreamedEvent } from "./event-stream";
export { FakeGitHub } from "./fake-github";
export { FakeHost } from "./fake-host";
export { FakeIdentity } from "./fake-identity";
export { FakeModelProvider, type FakeModelReply, streamOf } from "./fake-model";
export { FakeClock } from "./fakes";
export { describeIdentityContract, type IdentityDriver } from "./identity-contract";
export {
  describeErrorPresentationContract,
  describeModelAdmissionContract,
  describeProviderRoutingContract,
} from "./model-contracts";
export { createTestApp, type TestApp, type TestAppOptions } from "./test-app";
export { TestBrowser } from "./test-browser";
