import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { localForageStorage } from "@/lib/localforage-storage";
import { defaultCreationPipeline, validatePipelineConfig, type SkillPipelineConfig } from "@/lib/agent/creation-pipeline";
import type { SkillFileOverrides } from "@/lib/agent/creation-skills";

type Store = {
    hydrated: boolean;
    config: SkillPipelineConfig;
    files: SkillFileOverrides;
    setConfig: (value: SkillPipelineConfig) => void;
    importBundle: (config: unknown, files: SkillFileOverrides) => void;
    reset: () => void;
};
export const useCreationPipelineStore = create<Store>()(persist((set) => ({
    hydrated: false, config: defaultCreationPipeline(), files: {},
    setConfig: (value) => set({ config: validatePipelineConfig(value) }),
    importBundle: (config, files) => set({ config: validatePipelineConfig(config), files }),
    reset: () => set({ config: defaultCreationPipeline(), files: {} }),
}), {
    name: "infinite-canvas:creation_pipeline_store",
    storage: createJSONStorage(() => localForageStorage),
    partialize: ({ config, files }) => ({ config, files }),
    onRehydrateStorage: () => (state) => { if (state) useCreationPipelineStore.setState({ hydrated: true }); },
}));
