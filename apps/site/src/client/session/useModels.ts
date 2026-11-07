import type { ThinkingEffort } from "@seekcloud/protocol";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { ModelInfo } from "./ModelPicker";

export interface ModelList {
  models: ModelInfo[];
  defaultModel: string;
  defaultEffort: ThinkingEffort;
}

let cached: Promise<ModelList> | undefined;

/** 可选的模型。整个页面只取一次。 */
export function useModels(): ModelList | undefined {
  const [list, setList] = useState<ModelList>();
  useEffect(() => {
    cached ??= api<ModelList>("/api/models");
    cached.then(setList, () => {
      cached = undefined;
    });
  }, []);
  return list;
}
