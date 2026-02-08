import type { ScriptMetadata } from "../types/agent";

const REGISTER_MARKER = /^ZACE_SCRIPT_REGISTER\|([^|\r\n]+)\|([^|\r\n]+)\|(.+)$/;
const USE_MARKER = /^ZACE_SCRIPT_USE\|([^|\r\n]+)$/;

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
