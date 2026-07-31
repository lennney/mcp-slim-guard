import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerManagerStartReport } from "./server-manager.js";

const ESTIMATOR_ID = "chars-div-4-v1";

interface CatalogEstimate {
  tools: number;
  characters: number;
  estimatedTokens: number;
}

interface InputSchemaEstimate {
  name: string;
  characters: number;
  estimatedTokens: number;
}

export interface AnalyzeReport {
  schemaVersion: 1;
  kind: "mcp-slim-guard/analyze";
  mode: "read-only";
  estimator: {
    id: typeof ESTIMATOR_ID;
    description: "ceil(JSON characters / 4)";
  };
  servers: {
    configured: number;
    connected: ServerManagerStartReport["connected"];
    failed: ServerManagerStartReport["failed"];
  };
  catalog: {
    direct: CatalogEstimate;
    slimGuard: CatalogEstimate;
    estimatedReductionPercent: number;
  };
  largestInputSchemas: InputSchemaEstimate[];
  operations: ["tools/list"];
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

function serializedCharacters(value: unknown): number {
  return JSON.stringify(value).length;
}

function catalogEstimate(tools: Tool[]): CatalogEstimate {
  const characters = tools.reduce((total, tool) => total + serializedCharacters(tool), 0);
  return {
    tools: tools.length,
    characters,
    estimatedTokens: estimateTokens(characters),
  };
}

export function buildAnalyzeReport(
  startReport: ServerManagerStartReport,
  directTools: Tool[],
  slimGuardTools: Tool[],
): AnalyzeReport {
  const direct = catalogEstimate(directTools);
  const slimGuard = catalogEstimate(slimGuardTools);
  const estimatedReductionPercent =
    direct.characters === 0 ? 0 : Math.round((1 - slimGuard.characters / direct.characters) * 100);

  const largestInputSchemas = directTools
    .map((tool) => {
      const characters = serializedCharacters(tool.inputSchema ?? {});
      return {
        name: tool.name,
        characters,
        estimatedTokens: estimateTokens(characters),
      };
    })
    .sort((left, right) => right.characters - left.characters || left.name.localeCompare(right.name))
    .slice(0, 10);

  return {
    schemaVersion: 1,
    kind: "mcp-slim-guard/analyze",
    mode: "read-only",
    estimator: {
      id: ESTIMATOR_ID,
      description: "ceil(JSON characters / 4)",
    },
    servers: {
      configured: startReport.configured,
      connected: [...startReport.connected].sort((left, right) => left.serverName.localeCompare(right.serverName)),
      failed: [...startReport.failed].sort((left, right) => left.serverName.localeCompare(right.serverName)),
    },
    catalog: {
      direct,
      slimGuard,
      estimatedReductionPercent,
    },
    largestInputSchemas,
    operations: ["tools/list"],
  };
}
