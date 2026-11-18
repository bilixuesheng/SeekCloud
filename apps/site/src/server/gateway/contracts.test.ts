import {
  describeErrorPresentationContract,
  describeModelAdmissionContract,
  describeProviderRoutingContract,
} from "../../testing/model-contracts";
import { createTestApp } from "../../testing/test-app";
import { deepseekRouting, transparentErrors, usageAdmission } from "./trunk";

describeProviderRoutingContract("主干的 DeepSeek 官方", async () => {
  const t = await createTestApp();
  return { routing: deepseekRouting(t.deps), close: t.close };
});

describeModelAdmissionContract("主干的记用量", async () => {
  const t = await createTestApp();
  return { admission: usageAdmission(t.deps), close: t.close };
});

describeErrorPresentationContract("主干的对管理员透明", transparentErrors);
