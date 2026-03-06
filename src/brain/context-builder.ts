import type { BrainPaths } from "./paths";

export type BrainContextFileDescriptor = {
  alwaysLoad: boolean;
  label: string;
  path: string;
};

export function getCoreBrainContextFiles(paths: BrainPaths): BrainContextFileDescriptor[] {
  return [
    {
      alwaysLoad: true,
      label: "identity",
      path: paths.identityFile,
    },
    {
      alwaysLoad: true,
      label: "working_memory",
      path: paths.workingMemoryFile,
    },
    {
      alwaysLoad: true,
      label: "current_plan",
      path: paths.currentPlanFile,
    },
  ];
}
