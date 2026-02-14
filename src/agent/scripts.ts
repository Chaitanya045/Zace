import type { ScriptMetadata } from "../types/agent";

export const SCRIPT_DIRECTORY_PATH = ".zace/runtime/scripts";
export const SCRIPT_REGISTRY_PATH = `${SCRIPT_DIRECTORY_PATH}/registry.tsv`;

const REGISTER_MARKER = /^ZACE_SCRIPT_REGISTER\|([^|\r\n]+)\|([^|\r\n]+)\|(.+)$/;
const USE_MARKER = /^ZACE_SCRIPT_USE\|([^|\r\n]+)$/;
const REGISTRY_HEADER = "id\tpath\tpurpose\tlast_touched_step\ttimes_used";

export interface ScriptCatalogUpdateResult {
  catalog: Map<string, ScriptMetadata>;
  notes: string[];
}

function applyRegisterMarker(
  catalog: Map<string, ScriptMetadata>,
  id: string,
  path: string,
  purpose: string,
  step: number
): string {
  const existing = catalog.get(id);

  catalog.set(id, {
    id,
    lastTouchedStep: step,
    path,
    purpose,
    timesUsed: existing?.timesUsed ?? 0,
  });

  return existing ? `updated script ${id}` : `registered script ${id}`;
}

function applyUseMarker(catalog: Map<string, ScriptMetadata>, id: string, step: number): string {
  const existing = catalog.get(id);

  if (!existing) {
    catalog.set(id, {
      id,
      lastTouchedStep: step,
      path: "unknown",
      purpose: "Discovered via usage marker",
      timesUsed: 1,
    });
    return `discovered script ${id} via usage marker`;
  }

  catalog.set(id, {
    ...existing,
    lastTouchedStep: step,
    timesUsed: existing.timesUsed + 1,
  });

  return `used script ${id}`;
}

export function updateScriptCatalogFromOutput(
  currentCatalog: Map<string, ScriptMetadata>,
  output: string,
  step: number
): ScriptCatalogUpdateResult {
  const catalog = new Map(currentCatalog);
  const notes: string[] = [];

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line) {
      continue;
    }

    const registerMatch = line.match(REGISTER_MARKER);
    if (registerMatch) {
      const [, rawId, rawPath, rawPurpose] = registerMatch;
      const id = rawId?.trim();
      const path = rawPath?.trim();
      const purpose = rawPurpose?.trim();
      if (!id || !path || !purpose) {
        continue;
      }

      notes.push(applyRegisterMarker(catalog, id, path, purpose, step));
      continue;
    }

    const useMatch = line.match(USE_MARKER);
    if (useMatch) {
      const [, rawId] = useMatch;
      const id = rawId?.trim();
      if (!id) {
        continue;
      }

      notes.push(applyUseMarker(catalog, id, step));
    }
  }

  return {
    catalog,
    notes,
  };
}

function sanitizeTsvField(value: string): string {
  return value.replaceAll("\n", " ").replaceAll("\r", " ").replaceAll("\t", " ").trim();
}

function buildBunEvalCommand(source: string): string {
  const sourceBase64 = Buffer.from(source, "utf8").toString("base64");
  const loader =
    "const source = Buffer.from(process.argv[1], \"base64\").toString(\"utf8\");const moduleBase64 = Buffer.from(source).toString(\"base64\");await import(\"data:text/javascript;base64,\" + moduleBase64);";
  return `bun -e '${loader}' '${sourceBase64}'`;
}

export function serializeScriptCatalog(catalog: Map<string, ScriptMetadata>): string {
  const rows = Array.from(catalog.values())
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((script) => {
      const id = sanitizeTsvField(script.id);
      const path = sanitizeTsvField(script.path);
      const purpose = sanitizeTsvField(script.purpose);
      return `${id}\t${path}\t${purpose}\t${script.lastTouchedStep}\t${script.timesUsed}`;
    });

  if (rows.length === 0) {
    return `${REGISTRY_HEADER}\n`;
  }

  return `${REGISTRY_HEADER}\n${rows.join("\n")}\n`;
}

export function buildRegistrySyncCommand(catalog: Map<string, ScriptMetadata>): string {
  const content = serializeScriptCatalog(catalog);
  const contentBase64 = Buffer.from(content, "utf8").toString("base64");
  const source = `
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(${JSON.stringify(SCRIPT_DIRECTORY_PATH)}, { recursive: true });
const content = Buffer.from(${JSON.stringify(contentBase64)}, "base64").toString("utf8");
writeFileSync(${JSON.stringify(SCRIPT_REGISTRY_PATH)}, content, "utf8");
`.trim();

  return buildBunEvalCommand(source);
}

export function buildDiscoverScriptsCommand(): string {
  const source = `
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const scriptDirectoryPath = ${JSON.stringify(SCRIPT_DIRECTORY_PATH)};
mkdirSync(scriptDirectoryPath, { recursive: true });

for (const entry of readdirSync(scriptDirectoryPath)) {
  if (!entry.endsWith(".ps1") && !entry.endsWith(".sh")) {
    continue;
  }

  const fullPath = join(scriptDirectoryPath, entry);
  if (!statSync(fullPath).isFile()) {
    continue;
  }

  const id = entry.replace(/\\.(ps1|sh)$/iu, "");
  let content = "";
  let purpose = "Existing runtime script";
  try {
    content = readFileSync(fullPath, "utf8");
  } catch (_error) {
    content = "";
  }

  for (const line of content.split(/\\r?\\n/u)) {
    if (!line.startsWith("# zace-purpose:")) {
      continue;
    }

    const parsedPurpose = line.replace("# zace-purpose:", "").trim();
    if (parsedPurpose.length > 0) {
      purpose = parsedPurpose;
    }
    break;
  }

  console.log("ZACE_SCRIPT_REGISTER|" + id + "|" + fullPath + "|" + purpose);
}
`.trim();

  return buildBunEvalCommand(source);
}
