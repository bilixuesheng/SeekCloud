import {
  describeErrorPresentationContract,
  describeModelAdmissionContract,
  describeProviderRoutingContract,
} from "../../testing/model-contracts";
import { createTestApp } from "../../testing/test-app";
import { configuredRouting, transparentErrors, usageAdmission } from "./trunk";

describeProviderRoutingContract("主干的按设置路由", async () => {
  const t = await createTestApp();
  return { routing: configuredRouting(t.deps), close: t.close };
});

describeModelAdmissionContract("主干的记用量", async () => {
  const t = await createTestApp();
  return { admission: usageAdmission(t.deps), close: t.close };
});

describeErrorPresentationContract("主干的对管理员透明", transparentErrors);
