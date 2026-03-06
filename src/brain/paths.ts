import { join, relative, resolve } from "node:path";

export type BrainPaths = {
  artifactsDirectory: string;
  brainDirectory: string;
  completedTasksFile: string;
  currentPlanFile: string;
  decisionsFile: string;
  edgesFile: string;
  episodicLogsDirectory: string;
  fileImportanceFile: string;
  identityFile: string;
  knowledgeFile: string;
  memoryGraphDirectory: string;
  nodesFile: string;
  plannerDirectory: string;
  repoMapFile: string;
  rootDirectory: string;
  sessionLogsDirectory: string;
  summariesDirectory: string;
  workingMemoryFile: string;
};

export function getBrainPaths(workspaceRoot: string): BrainPaths {
  const rootDirectory = resolve(workspaceRoot, ".zace");
  const brainDirectory = join(rootDirectory, "brain");
  const plannerDirectory = join(rootDirectory, "planner");
  const episodicLogsDirectory = join(rootDirectory, "episodic_memory");
  const sessionLogsDirectory = join(episodicLogsDirectory, "session_logs");
  const memoryGraphDirectory = join(rootDirectory, "memory_graph");

  return {
    artifactsDirectory: join(rootDirectory, "artifacts"),
    brainDirectory,
    completedTasksFile: join(plannerDirectory, "completed_tasks.json"),
    currentPlanFile: join(plannerDirectory, "current_plan.json"),
    decisionsFile: join(brainDirectory, "decisions.md"),
    edgesFile: join(memoryGraphDirectory, "edges.json"),
    episodicLogsDirectory,
    fileImportanceFile: join(rootDirectory, "file_importance.json"),
    identityFile: join(brainDirectory, "identity.md"),
    knowledgeFile: join(brainDirectory, "knowledge.md"),
    memoryGraphDirectory,
    nodesFile: join(memoryGraphDirectory, "nodes.json"),
    plannerDirectory,
    repoMapFile: join(brainDirectory, "repo_map.md"),
    rootDirectory,
    sessionLogsDirectory,
    summariesDirectory: join(rootDirectory, "summaries"),
    workingMemoryFile: join(rootDirectory, "working_memory.json"),
  };
}

export function toWorkspaceRelativePath(workspaceRoot: string, pathValue: string): string {
  const relativePath = relative(resolve(workspaceRoot), resolve(pathValue));
  if (!relativePath) {
    return ".";
  }

  return relativePath;
}
