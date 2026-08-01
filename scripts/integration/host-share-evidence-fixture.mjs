#!/usr/bin/env node

import fs from "node:fs";
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
const auditPath = process.env.SLIM_GUARD_FIXTURE_AUDIT_PATH;

const tools = [
  {
    name: "long_text",
    description: "Return a deterministic oversized plain-text report for host acceptance testing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "json_array",
    description: "Return a deterministic oversized uniform JSON array for host acceptance testing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "logs",
    description: "Return deterministic oversized log-like text for host acceptance testing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "structured",
    description: "Return schema-bound structured content that must pass through unchanged.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { marker: { type: "string" }, status: { type: "string" } },
      required: ["marker", "status"],
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function recordCall(name) {
  if (auditPath) fs.appendFileSync(auditPath, `${JSON.stringify({ tool: name })}\n`, "utf8");
}

function callResult(name) {
  recordCall(name);
  if (name === "long_text") {
    const text = Array.from(
      { length: 600 },
      (_, index) => `${String(index + 1).padStart(4, "0")} EVIDENCE_LONG_TEXT stable operational context`,
    ).join("\n");
    return { content: [{ type: "text", text }] };
  }
  if (name === "json_array") {
    const text = JSON.stringify(
      Array.from({ length: 600 }, (_, index) => ({
        index,
        status: index % 7 === 0 ? "warning" : "ok",
        marker: `EVIDENCE_JSON_${String(index).padStart(4, "0")}`,
      })),
    );
    return { content: [{ type: "text", text }] };
  }
  if (name === "logs") {
    const text = [
      "INFO acceptance run started",
      ...Array.from({ length: 700 }, () => "DEBUG worker heartbeat stable"),
      "ERROR EVIDENCE_LOG_FAILURE deterministic boundary",
      "INFO acceptance run completed",
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
  if (name === "structured") {
    const structuredContent = { marker: "EVIDENCE_STRUCTURED_PASS_THROUGH", status: "ok" };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}

input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "host-share-evidence-fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools } });
    return;
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: callResult(request.params?.name) });
    return;
  }
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
});
