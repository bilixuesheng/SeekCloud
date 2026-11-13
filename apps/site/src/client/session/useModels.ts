import type { ThinkingEffort } from "@seekcloud/protocol";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { ModelInfo } from "./ModelPicker";

export interface ModelList {
  models: ModelInfo[];
  defaultModel: string;
  /** 设置里的默认思考强度。 */
  defaultEffort: ThinkingEffort;
}

let cached: Promise<ModelList> | undefined;
const listeners = new Set<(list: ModelList) => void>();

function load(): Promise<ModelList> {
  const request = api<ModelList>("/api/models");
  cached = request;
  request.then(
    (list) => {
      for (const listener of listeners) listener(list);
    },
    () => {
      if (cached === request) cached = undefined;
    },
  );
  return request;
}

/** 可选的模型和默认值。整个页面只取一次；设置里改了默认值以后用 reloadModels 再取。 */
export function useModels(): ModelList | undefined {
  const [list, setList] = useState<ModelList>();
  useEffect(() => {
    listeners.add(setList);
    (cached ?? load()).then(setList, () => undefined);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

/** 重新取模型列表，用到它的地方都跟着更新。 */
export function reloadModels(): void {
  void load().catch(() => undefined);
}
