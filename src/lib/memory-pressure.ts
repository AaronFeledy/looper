import { trimLoopStateMemory, type LoopState } from "./state.ts";

export function installMemoryPressureTrimmer(getState: () => LoopState | null): () => void {
  const onPressure = (_level: "warning" | "critical"): void => {
    try {
      const state = getState();
      if (state === null) return;
      trimLoopStateMemory(state);
    } catch {
      // no-excuse-ok: catch — fail-open
    }
  };
  process.on("memoryPressure", onPressure);
  return () => {
    process.off("memoryPressure", onPressure);
  };
}
