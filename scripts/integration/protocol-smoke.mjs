#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.argv.find((argument) => argument.startsWith("--url="))?.slice("--url=".length);
if (!endpoint) throw new Error("Usage: node protocol-smoke.mjs --url=http://127.0.0.1:PORT/mcp");

function textJson(result) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("Expected text result");
  return JSON.parse(block.text);
}

const client = new Client({ name: "slim-guard-protocol-smoke", version: "1.0.0" }, { capabilities: { tools: {} } });

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["call_tool", "find_tool", "read_result"])) {
    throw new Error(`Unexpected tool surface: ${names.join(", ")}`);
  }
  const found = await client.callTool({
    name: "find_tool",
    arguments: { query: "search product catalog" },
  });
  const match = textJson(found).matches?.find((candidate) => candidate.name === "fixture_search_catalog");
  if (!match?.tool_ref) throw new Error("fixture_search_catalog was not discovered");
  const called = await client.callTool({
    name: "call_tool",
    arguments: {
      tool_ref: match.tool_ref,
      arguments: { query: "adapter", locale: "en", limit: 3 },
    },
  });
  const wire = JSON.stringify(called);
  if (!wire.includes("CATALOG:adapter:en")) throw new Error("Expected fixture marker was not returned");
  console.log(
    JSON.stringify({
      endpoint,
      protocol: "Streamable HTTP",
      tools: names,
      flow: ["find_tool", "call_tool"],
      marker: "CATALOG:adapter:en",
      passed: true,
    }),
  );
} finally {
  await client.close().catch(() => {});
}
