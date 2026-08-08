/**
 * Read-only runtime acceptance for one selected public mode.
 *
 * This module deliberately exercises the same GuardProxy surface a Host uses,
 * while stopping before any authorized upstream Tool is called. It therefore
 * proves discovery, authorization, and schema handoff without turning a
 * verification command into a potentially side-effecting smoke test.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AuditLogger } from "./audit.js";
import { authorizedTools } from "./authorized-catalog.js";
import type { GuardConfig } from "./config-types.js";
import type { GuardMode } from "./modes.js";
import { PolicyPipeline } from "./policies/base.js";
import { GuardProxy } from "./proxy.js";
import { ServerManager } from "./server-manager.js";
import { CALL_TOOL, FIND_TOOL, READ_RESULT } from "./secure-projection.js";

export interface ModeAcceptanceReport {
  schemaVersion: 1;
  kind: "mcp-slim-guard/mode-acceptance";
  status: "passed";
  mode: GuardMode;
  upstream: {
    catalogTools: number;
    authorizedTools: number;
  };
  host: {
    tools: string[];
    schemaCheck: "exact";
  };
  safety: {
    hostConfigurationWrites: 0;
    upstreamToolCalls: 0;
    resultRecovery: "not_run";
  };
}

export interface ModeAcceptanceDependencies {
  manager: ServerManager;
  pipeline: PolicyPipeline;
  audit: AuditLogger;
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Mode verification received an invalid find_tool response.");
  }
  return first.text;
}

function hasTextContent(
  value: unknown,
): value is { content: Array<{ type: string; text?: string }>; isError?: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

function authorizedCatalog(config: GuardConfig, manager: ServerManager, tools: Tool[]): Tool[] {
  return authorizedTools(config.tools.allow.length === 0 ? [] : tools, config.tools.allow, config.tools.deny, (name) =>
    manager.getLegacyCatalogNames(name),
  ).filter((tool) => manager.resolveTool(tool.name) !== null);
}

function assertNativeSurface(listed: Tool[], authorized: Tool[], manager: ServerManager): void {
  const authorizedNames = new Set(authorized.map((tool) => tool.name));
  const expected = manager
    .getNativeTools()
    .filter((route) => authorizedNames.has(route.catalogName))
    .map((route) => route.tool);
  const expectedNames = [...expected.map((tool) => tool.name), READ_RESULT];
  if (JSON.stringify(listed.map((tool) => tool.name)) !== JSON.stringify(expectedNames)) {
    throw new Error("Native Host surface does not match the authorized catalog.");
  }
  for (const expectedTool of expected) {
    const observed = listed.find((tool) => tool.name === expectedTool.name);
    if (!observed || !exactJson(observed.inputSchema, expectedTool.inputSchema)) {
      throw new Error(`Native Host schema does not match authorized Tool "${expectedTool.name}".`);
    }
  }
}

async function assertProjectedSurface(client: Client, listed: Tool[], authorized: Tool[]): Promise<void> {
  const expectedNames = [FIND_TOOL, CALL_TOOL, READ_RESULT];
  if (JSON.stringify(listed.map((tool) => tool.name)) !== JSON.stringify(expectedNames)) {
    throw new Error("Compact or Extreme Host surface must contain exactly find_tool, call_tool, and read_result.");
  }

  const anchor = authorized[0];
  if (!anchor) throw new Error("No authorized Tool is available for schema verification.");
  const found = await client.callTool({ name: FIND_TOOL, arguments: { query: anchor.name } });
  if (!hasTextContent(found)) throw new Error("Mode verification received an incomplete find_tool response.");
  if (found.isError) throw new Error("find_tool rejected the authorized schema verification query.");
  let payload: { matches?: Array<{ name?: string; input_schema?: unknown }> };
  try {
    payload = JSON.parse(resultText(found));
  } catch {
    throw new Error("Mode verification could not parse the find_tool response.");
  }
  const match = payload.matches?.find((candidate) => candidate.name === anchor.name);
  if (!match || !exactJson(match.input_schema, anchor.inputSchema)) {
    throw new Error(`On-demand schema does not exactly match authorized Tool "${anchor.name}".`);
  }
}

/**
 * Exercise the selected Host-facing mode without calling a business Tool.
 * GuardProxy owns lifecycle cleanup, including upstream connections and audit.
 */
export async function verifyModeAcceptance(
  config: GuardConfig,
  mode: GuardMode,
  dependencies: ModeAcceptanceDependencies,
): Promise<ModeAcceptanceReport> {
  const proxy = new GuardProxy(config, dependencies.pipeline, dependencies.audit, dependencies.manager, { mode });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-slim-guard-verify", version: "1" }, { capabilities: {} });
  let proxyStarted = false;

  try {
    await proxy.start(serverTransport);
    proxyStarted = true;
    await client.connect(clientTransport);

    const catalog = dependencies.manager.getTools();
    const authorized = authorizedCatalog(config, dependencies.manager, catalog);
    if (catalog.length === 0) throw new Error("No upstream Tools were discovered. Check upstream connectivity first.");
    if (authorized.length === 0) throw new Error("No upstream Tools are authorized by the current allow/deny policy.");

    const listed = (await client.listTools()).tools as Tool[];
    if (mode === "native") {
      assertNativeSurface(listed, authorized, dependencies.manager);
    } else {
      await assertProjectedSurface(client, listed, authorized);
    }

    return {
      schemaVersion: 1,
      kind: "mcp-slim-guard/mode-acceptance",
      status: "passed",
      mode,
      upstream: {
        catalogTools: catalog.length,
        authorizedTools: authorized.length,
      },
      host: {
        tools: listed.map((tool) => tool.name),
        schemaCheck: "exact",
      },
      safety: {
        hostConfigurationWrites: 0,
        upstreamToolCalls: 0,
        resultRecovery: "not_run",
      },
    };
  } finally {
    await client.close().catch(() => {});
    if (proxyStarted) await proxy.stop().catch(() => {});
  }
}
