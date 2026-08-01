#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AuditLogger, GuardProxy, PolicyPipeline, ServerManager, WhitelistPolicy } from "mcp-slim-guard";

const fixture = process.argv[2];
if (!fixture) throw new Error("Expected the fixture entry path");

const argumentSecret = "NATIVE_PACKAGE_ARGUMENT_SECRET_74c63b";
const largeMarker = `NATIVE_PACKAGE_LARGE:${argumentSecret}:CALLS:1`;
const largeText = `${largeMarker}\n${"native package payload\n".repeat(3_000)}`;
const structuredMarker = "NATIVE_PACKAGE_STRUCTURED:beta:CALLS:2";
const config = {
  version: 1,
  tools: { allow: ["fixture_native_*"], deny: [] },
  ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] },
  rate_limit: { default: "1000/min" },
  injection_detection: { enabled: false },
  compressor: { enabled: true, level: "light" },
  servers: {
    fixture: {
      command: process.execPath,
      args: [fixture],
      env: {},
    },
  },
};

const audit = new AuditLogger();
const manager = new ServerManager(config.servers);
const proxy = new GuardProxy(config, new PolicyPipeline([new WhitelistPolicy(config.tools)]), audit, manager, {
  surface: "native",
});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client(
  { name: "installed-native-package-consumer", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

async function recoverText(delivered) {
  const resultRef = delivered.structuredContent?.result_ref;
  assert.equal(typeof resultRef, "string", "eligible native text did not return a result_ref");

  let cursor = 0;
  let recovered = "";
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const page = await client.callTool({
      name: "read_result",
      arguments: { result_ref: resultRef, cursor },
    });
    const chunk = page.content?.[0];
    assert.equal(chunk?.type, "text", "read_result did not return a text chunk");
    assert.equal(
      page.structuredContent?.chunk,
      chunk.text,
      "read_result did not expose the exact chunk to structured-only Hosts",
    );
    recovered += chunk.text;

    const metadata = page.structuredContent;
    if (metadata?.done === true) return { recovered, resultRef, pages: pageCount + 1 };
    assert.equal(typeof metadata?.next_cursor, "number", "read_result omitted its next cursor");
    cursor = metadata.next_cursor;
  }
  throw new Error("read_result exceeded the bounded smoke pagination limit");
}

let started = false;
let connected = false;
try {
  await proxy.start(serverTransport);
  started = true;
  await client.connect(clientTransport);
  connected = true;

  const listed = await client.listTools();
  const toolNames = listed.tools.map(({ name }) => name);
  assert.deepEqual(toolNames, ["native_large", "native_structured", "read_result"]);
  assert.equal(toolNames.includes("marker"), false, "unauthorized marker Tool leaked into native discovery");

  const largeDefinition = listed.tools.find(({ name }) => name === "native_large");
  assert.equal(largeDefinition?.title, "Native large package result");
  assert.deepEqual(largeDefinition?._meta, { fixture: "native-package-smoke" });

  const structuredDefinition = listed.tools.find(({ name }) => name === "native_structured");
  assert.deepEqual(structuredDefinition?.outputSchema, {
    type: "object",
    properties: {
      marker: { type: "string" },
      count: { type: "number" },
    },
    required: ["marker", "count"],
    additionalProperties: false,
  });

  const delivered = await client.callTool({
    name: "native_large",
    arguments: { value: argumentSecret },
  });
  const recovery = await recoverText(delivered);
  assert.equal(recovery.recovered, largeText, "read_result did not recover the exact native snapshot");

  const structured = await client.callTool({
    name: "native_structured",
    arguments: { value: "beta" },
  });
  assert.deepEqual(structured.content, [{ type: "text", text: structuredMarker }]);
  assert.deepEqual(structured.structuredContent, { marker: structuredMarker, count: 2 });
  assert.deepEqual(structured._meta, { fixture: "native-package-smoke" });
  assert.deepEqual(structured["x-native-package-smoke-result"], { preserved: true });

  await client.close();
  connected = false;
  await proxy.stop();
  started = false;

  process.stdout.write(
    `${JSON.stringify({
      tools: toolNames,
      unauthorized_tools_hidden: true,
      direct_large_calls: 1,
      recovery_upstream_calls: 0,
      structured_calls: 1,
      total_upstream_calls: 2,
      projection: delivered.structuredContent?.projection,
      recovery_pages: recovery.pages,
      recovered_sha256: createHash("sha256").update(recovery.recovered).digest("hex"),
      expected_sha256: createHash("sha256").update(largeText).digest("hex"),
      structured_preserved: true,
      output_schema_preserved: true,
      package_root_runtime: proxy.constructor.name === "GuardProxy",
      node: process.version,
      _result_ref: recovery.resultRef,
      passed: true,
    })}\n`,
  );
} finally {
  if (connected) await client.close().catch(() => {});
  if (started) await proxy.stop().catch(() => {});
}
