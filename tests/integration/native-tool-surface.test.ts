import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { GuardProxy } from "../../src/proxy.js";
import { ServerManager } from "../../src/server-manager.js";
import { PolicyPipeline } from "../../src/policies/base.js";
import { WhitelistPolicy } from "../../src/policies/whitelist.js";
import { AuditLogger } from "../../src/audit.js";
import type { GuardConfig } from "../../src/config-types.js";
import { InMemoryUpstreamConnector } from "../helpers/in-memory-upstream.js";

function config(): GuardConfig {
  return {
    version: 1,
    tools: { allow: ["fixture_*"], deny: [] },
    ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] },
    rate_limit: { default: "" },
    injection_detection: { enabled: false },
    compressor: { enabled: false, level: "off" },
    servers: { fixture: { command: "test-fixture" } },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tool(name: string, description = `${name} fixture`): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { marker: { type: "string" } },
      additionalProperties: false,
    },
  };
}

async function startNativeRuntime(
  currentConfig: GuardConfig,
  connector: InMemoryUpstreamConnector,
  audit = new AuditLogger({ output: "stderr", level: "silent" }),
  prepareServerTransport?: (transport: InMemoryTransport) => void,
  clientOptions: ClientOptions = { capabilities: {} },
) {
  const manager = new ServerManager(currentConfig.servers, connector);
  const proxy = new GuardProxy(
    currentConfig,
    new PolicyPipeline([new WhitelistPolicy(currentConfig.tools)]),
    audit,
    manager,
    { surface: "native" },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  prepareServerTransport?.(serverTransport);
  const client = new Client({ name: "native-fixture-host", version: "1.0.0" }, clientOptions);
  await proxy.start(serverTransport);
  await client.connect(clientTransport);
  return { audit, client, manager, proxy };
}

async function closeNativeRuntime(runtime: Awaited<ReturnType<typeof startNativeRuntime>>): Promise<void> {
  await runtime.client.close().catch(() => {});
  await runtime.proxy.stop().catch(() => {});
}

async function recoverText(client: Client, delivered: CallToolResult): Promise<string> {
  const capsule = delivered.structuredContent as Record<string, unknown>;
  const resultRef = capsule.result_ref;
  if (typeof resultRef !== "string") throw new Error("expected a native capsule reference");
  let cursor = 0;
  let text = "";
  for (;;) {
    const page = await client.callTool({
      name: "read_result",
      arguments: { result_ref: resultRef, cursor },
    });
    const chunk = page.content[0];
    if (!chunk || chunk.type !== "text") throw new Error("expected a recovery text chunk");
    text += chunk.text;
    const metadata = page.structuredContent as { done: boolean; next_cursor: number | null };
    if (metadata.done) return text;
    if (typeof metadata.next_cursor !== "number") throw new Error("expected a recovery cursor");
    cursor = metadata.next_cursor;
  }
}

describe("Host-native MCP Tool surface", () => {
  it("keeps native identity, routes once, projects eligible text, and passes structured output through", async () => {
    const searchTool: Tool = {
      name: "search",
      title: "Search fixture",
      description: "Search the deterministic fixture",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      annotations: { readOnlyHint: true },
      _meta: { provider: "fixture" },
    };
    const structuredTool: Tool = {
      name: "structured",
      description: "Return structured fixture data",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
    };
    const largeText = `${"native-fixture-line\n".repeat(1_100)}NATIVE_FIXTURE_END`;
    const argumentSecret = "NATIVE_ARGUMENT_SECRET_9f8c5a";
    const connector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [searchTool, structuredTool],
        call: async (toolName): Promise<CallToolResult> =>
          toolName === "search"
            ? { content: [{ type: "text", text: largeText }] }
            : {
                content: [{ type: "text", text: "structured" }],
                structuredContent: { count: 1 },
                _meta: { provider: "fixture" },
                "x-result-fixture": true,
              },
      },
    });
    const runtime = await startNativeRuntime(config(), connector);
    const { audit, client } = runtime;

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["search", "structured", "read_result"]);
      expect(listed.tools.find((tool) => tool.name === "search")).toMatchObject({
        title: "Search fixture",
        annotations: { readOnlyHint: true },
        _meta: { provider: "fixture" },
      });

      const args = { query: argumentSecret };
      const delivered = await client.callTool({ name: "search", arguments: args });
      const resultRef = (delivered.structuredContent as Record<string, unknown>).result_ref;
      expect(resultRef).toMatch(/^result_/);
      if (typeof resultRef !== "string") throw new Error("expected a native capsule reference");
      expect(connector.state("fixture").calls).toHaveLength(1);
      expect(connector.state("fixture").calls[0]?.args).toEqual(args);
      expect(await recoverText(client, delivered)).toBe(largeText);
      expect(connector.state("fixture").calls).toHaveLength(1);

      const passthroughResultSchema = {
        safeParse(value: unknown) {
          return { success: true as const, data: value };
        },
      } as never;
      const structured = await client.callTool({ name: "structured", arguments: {} }, passthroughResultSchema);
      expect(structured).toMatchObject({
        structuredContent: { count: 1 },
        _meta: { provider: "fixture" },
      });
      expect((structured as CallToolResult & Record<string, unknown>)["x-result-fixture"]).toBe(true);
      expect(connector.state("fixture").calls).toHaveLength(2);

      const searchTrace = audit
        .getEntries()
        .filter((entry) => entry.traceId !== undefined && entry.toolName === "fixture_search");
      expect(new Set(searchTrace.map((entry) => entry.traceId)).size).toBe(1);
      expect(searchTrace.map((entry) => entry.event)).toEqual(["policy", "upstream", "projection"]);
      expect(searchTrace.map((entry) => entry.outcome)).toEqual(["success", "success", "projected"]);
      expect(searchTrace.every((entry) => Object.keys(entry.arguments).length === 0)).toBe(true);
      expect(searchTrace[2]?.metadata).toMatchObject({
        upstreamInvoked: true,
        capsule: {
          phase: "delivery",
          outcome: "projected",
          referenceId: expect.stringMatching(/^[a-f0-9]{16}$/),
        },
      });

      const structuredTrace = audit
        .getEntries()
        .filter((entry) => entry.traceId !== undefined && entry.toolName === "fixture_structured");
      expect(structuredTrace.map((entry) => entry.event)).toEqual(["policy", "upstream", "projection"]);
      expect(structuredTrace.map((entry) => entry.outcome)).toEqual(["success", "success", "pass_through"]);
      expect(structuredTrace.every((entry) => Object.keys(entry.arguments).length === 0)).toBe(true);

      const serializedAudit = JSON.stringify(audit.getEntries());
      expect(serializedAudit).not.toContain(argumentSecret);
      expect(serializedAudit).not.toContain("NATIVE_FIXTURE_END");
      expect(serializedAudit).not.toContain(resultRef);

      const rejected = await client.callTool({ name: "not_advertised", arguments: {} });
      expect(rejected.isError).toBe(true);
      expect(connector.state("fixture").calls).toHaveLength(2);
    } finally {
      await closeNativeRuntime(runtime);
    }
  });

  it("drains an admitted call through response delivery before stop closes the transport", async () => {
    const started = deferred<void>();
    const released = deferred<CallToolResult>();
    const upstreamResult: CallToolResult = {
      content: [{ type: "text", text: "stop-call-complete" }],
    };
    const connector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [tool("slow")],
        call: async () => {
          started.resolve(undefined);
          return released.promise;
        },
      },
    });
    const runtime = await startNativeRuntime(config(), connector);
    let stopping: Promise<void> | undefined;

    try {
      let invocationSettled = false;
      const invocation = runtime.client.callTool({
        name: "slow",
        arguments: { marker: "admitted-before-stop" },
      });
      void invocation.then(
        () => {
          invocationSettled = true;
        },
        () => {
          invocationSettled = true;
        },
      );
      await started.promise;
      expect(connector.state("fixture").calls).toHaveLength(1);

      let stopSettled = false;
      stopping = runtime.proxy.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();

      expect(invocationSettled).toBe(false);
      expect(stopSettled).toBe(false);
      expect(connector.state("fixture").closed).toBe(false);

      released.resolve(upstreamResult);
      await expect(invocation).resolves.toEqual(upstreamResult);
      expect(connector.state("fixture").calls).toHaveLength(1);

      await stopping;
      expect(stopSettled).toBe(true);
      expect(connector.state("fixture").closed).toBe(true);
    } finally {
      released.resolve(upstreamResult);
      await stopping?.catch(() => {});
      await closeNativeRuntime(runtime);
    }
  });

  it("releases a cancelled call after upstream settles when the SDK sends no response", async () => {
    const started = deferred<void>();
    const released = deferred<CallToolResult>();
    const upstreamResult: CallToolResult = {
      content: [{ type: "text", text: "cancelled-call-complete" }],
    };
    const connector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [tool("slow")],
        call: async () => {
          started.resolve(undefined);
          return released.promise;
        },
      },
    });
    const runtime = await startNativeRuntime(config(), connector);
    let stopping: Promise<void> | undefined;

    try {
      const controller = new AbortController();
      const invocation = runtime.client.callTool({ name: "slow", arguments: {} }, undefined, {
        signal: controller.signal,
      });
      await started.promise;
      controller.abort();
      await invocation.catch(() => {});

      let stopSettled = false;
      stopping = runtime.proxy.stop().then(() => {
        stopSettled = true;
      });
      await Promise.resolve();
      expect(stopSettled).toBe(false);
      expect(connector.state("fixture").closed).toBe(false);

      released.resolve(upstreamResult);
      const outcome = await Promise.race([
        stopping.then(() => "stopped" as const),
        new Promise<"timed_out">((resolve) => {
          setTimeout(() => resolve("timed_out"), 100);
        }),
      ]);

      expect(outcome).toBe("stopped");
      expect(connector.state("fixture").closed).toBe(true);
    } finally {
      released.resolve(upstreamResult);
      await runtime.client.close().catch(() => {});
      if (stopping) {
        await Promise.race([
          stopping.catch(() => {}),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 10);
          }),
        ]);
      }
    }
  });

  it("rejects calls arriving during reload while an admitted call finishes on the old generation", async () => {
    const firstStarted = deferred<void>();
    const firstReleased = deferred<CallToolResult>();
    const firstResult: CallToolResult = {
      content: [{ type: "text", text: `${"retiring-generation\n".repeat(1_100)}RETIRING_GENERATION_END` }],
    };
    const oldConnector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [tool("switch")],
        call: async (_toolName, args) => {
          if (args.marker === "first") {
            firstStarted.resolve(undefined);
            return firstReleased.promise;
          }
          return { content: [{ type: "text", text: "old-queued-result" }] };
        },
      },
    });
    const nextConnector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [tool("switch")],
        call: async (_toolName, args) => ({
          content: [{ type: "text", text: `new-result:${String(args.marker)}` }],
        }),
      },
    });
    const currentConfig = config();
    const nextConfig = config();
    const runtime = await startNativeRuntime(currentConfig, oldConnector);
    const nextManager = new ServerManager(nextConfig.servers, nextConnector);
    await nextManager.start();
    let reload: Promise<void> | undefined;
    let firstInvocation: Promise<CallToolResult> | undefined;
    let rejectedInvocation: Promise<CallToolResult> | undefined;

    try {
      firstInvocation = runtime.client.callTool({
        name: "switch",
        arguments: { marker: "first" },
      });
      await firstStarted.promise;
      expect(oldConnector.state("fixture").calls).toHaveLength(1);

      let reloadSettled = false;
      reload = runtime.proxy
        .reload(nextConfig, new PolicyPipeline([new WhitelistPolicy(nextConfig.tools)]), undefined, nextManager)
        .then(() => {
          reloadSettled = true;
        });

      rejectedInvocation = runtime.client.callTool({
        name: "switch",
        arguments: { marker: "must-not-run" },
      });
      const controller = new AbortController();
      const cancelledInvocation = runtime.client.callTool(
        { name: "switch", arguments: { marker: "cancelled" } },
        undefined,
        {
          signal: controller.signal,
        },
      );
      controller.abort();

      expect(reloadSettled).toBe(false);
      await expect(rejectedInvocation).resolves.toMatchObject({ isError: true });
      await cancelledInvocation.catch(() => {});
      expect(oldConnector.state("fixture").calls).toHaveLength(1);
      expect(nextConnector.state("fixture").calls).toHaveLength(0);
      expect(oldConnector.state("fixture").closed).toBe(false);

      firstReleased.resolve(firstResult);
      await expect(firstInvocation).resolves.toEqual(firstResult);
      await reload;
      expect(oldConnector.state("fixture").closed).toBe(true);

      expect(oldConnector.state("fixture").calls).toHaveLength(1);
      expect(nextConnector.state("fixture").calls).toHaveLength(0);
    } finally {
      firstReleased.resolve(firstResult);
      await Promise.allSettled([firstInvocation, rejectedInvocation, reload].filter(Boolean) as Promise<unknown>[]);
      await closeNativeRuntime(runtime);
      await nextManager.stop();
    }
  });

  it("keeps the old generation when reload overlaps delivery of a projected result reference", async () => {
    const responseStarted = deferred<void>();
    const releaseResponse = deferred<void>();
    const largeText = `${"reload-delivery-race\n".repeat(1_100)}RELOAD_DELIVERY_END`;
    const oldConnector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [tool("search")],
        call: async () => ({ content: [{ type: "text", text: largeText }] }),
      },
    });
    const nextConnector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [tool("replacement")],
        call: async () => ({ content: [{ type: "text", text: "replacement-result" }] }),
      },
    });
    const currentConfig = config();
    const nextConfig = config();
    const runtime = await startNativeRuntime(currentConfig, oldConnector, undefined, (serverTransport) => {
      const send = serverTransport.send.bind(serverTransport);
      serverTransport.send = async (message, options) => {
        const result = "result" in message ? message.result : undefined;
        const structuredContent =
          result && typeof result === "object" && "structuredContent" in result ? result.structuredContent : undefined;
        if (
          structuredContent &&
          typeof structuredContent === "object" &&
          "result_ref" in structuredContent &&
          typeof structuredContent.result_ref === "string"
        ) {
          responseStarted.resolve(undefined);
          await releaseResponse.promise;
        }
        await send(message, options);
      };
    });
    const nextManager = new ServerManager(nextConfig.servers, nextConnector);
    await nextManager.start();
    let reload: Promise<void> | undefined;
    let invocation: Promise<CallToolResult> | undefined;

    try {
      invocation = runtime.client.callTool({ name: "search", arguments: {} });
      await responseStarted.promise;

      reload = runtime.proxy.reload(
        nextConfig,
        new PolicyPipeline([new WhitelistPolicy(nextConfig.tools)]),
        undefined,
        nextManager,
      );
      await Promise.resolve();
      expect(oldConnector.state("fixture").closed).toBe(false);

      releaseResponse.resolve(undefined);
      const delivered = await invocation;
      await expect(reload).rejects.toThrow(/projected result.*delivery/i);

      expect(oldConnector.state("fixture").closed).toBe(false);
      expect(nextConnector.state("fixture").closed).toBe(false);
      expect(await recoverText(runtime.client, delivered)).toBe(largeText);
      expect(oldConnector.state("fixture").calls).toHaveLength(1);
      expect(nextConnector.state("fixture").calls).toHaveLength(0);
      const candidateStopReport = await nextManager.stop();
      expect(candidateStopReport.closed).toEqual(["fixture"]);
      expect(nextConnector.state("fixture").closed).toBe(true);
    } finally {
      releaseResponse.resolve(undefined);
      await Promise.allSettled([invocation, reload].filter(Boolean) as Promise<unknown>[]);
      await closeNativeRuntime(runtime);
      await nextManager.stop();
    }
  });

  it("advertises and sends tools.listChanged when reload changes the native catalog", async () => {
    const changed = deferred<{ error: Error | null; tools: Tool[] | null }>();
    const oldConnector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [tool("search")],
      },
    });
    const nextConnector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [tool("replacement")],
      },
    });
    const currentConfig = config();
    const nextConfig = config();
    const runtime = await startNativeRuntime(currentConfig, oldConnector, undefined, undefined, {
      capabilities: {},
      listChanged: {
        tools: {
          debounceMs: 0,
          onChanged: (error, tools) => {
            changed.resolve({ error, tools });
          },
        },
      },
    });
    const nextManager = new ServerManager(nextConfig.servers, nextConnector);
    await nextManager.start();

    try {
      expect(runtime.client.getServerCapabilities()?.tools?.listChanged).toBe(true);
      expect((await runtime.client.listTools()).tools.map(({ name }) => name)).toEqual(["search", "read_result"]);

      await runtime.proxy.reload(
        nextConfig,
        new PolicyPipeline([new WhitelistPolicy(nextConfig.tools)]),
        undefined,
        nextManager,
      );

      const notification = await Promise.race([
        changed.promise,
        new Promise<"timed_out">((resolve) => {
          setTimeout(() => resolve("timed_out"), 250);
        }),
      ]);
      expect(notification).not.toBe("timed_out");
      if (notification === "timed_out") throw new Error("tools.listChanged notification timed out");
      expect(notification.error).toBeNull();
      expect(notification.tools?.map(({ name }) => name)).toEqual(["replacement", "read_result"]);
    } finally {
      await closeNativeRuntime(runtime);
      await nextManager.stop();
    }
  });

  it("returns JSON-RPC -32602 for malformed tools/call params without invoking upstream", async () => {
    const malformedSecret = "MALFORMED_ARGUMENT_SECRET_7f619a";
    const connector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [tool("search")],
        call: async () => ({ content: [{ type: "text", text: "must-not-run" }] }),
      },
    });
    const runtime = await startNativeRuntime(config(), connector);

    try {
      const failure = await runtime.client
        .request(
          {
            method: "tools/call",
            params: {
              name: "search",
              arguments: malformedSecret,
            },
          } as never,
          CallToolResultSchema,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(McpError);
      expect(failure).toMatchObject({ code: ErrorCode.InvalidParams });
      expect(connector.state("fixture").calls).toHaveLength(0);
      expect(JSON.stringify(runtime.audit.getEntries())).not.toContain(malformedSecret);
    } finally {
      await closeNativeRuntime(runtime);
    }
  });
});

describe("Generic compatibility Tool surface", () => {
  it("keeps a real Tool reachable when its catalog name occupies the wrapper namespace", async () => {
    const currentConfig: GuardConfig = {
      ...config(),
      tools: { allow: ["*"], deny: [] },
      compressor: { enabled: true, level: "off", lazy_loading: true },
      servers: { mcp_: { command: "test-fixture" } },
    };
    const connector = new InMemoryUpstreamConnector({
      mcp_: {
        tools: [tool("get_schema")],
        call: async (_toolName, args) => ({
          content: [{ type: "text", text: `upstream:${String(args.marker)}` }],
        }),
      },
    });
    const manager = new ServerManager(currentConfig.servers, connector);
    const proxy = new GuardProxy(
      currentConfig,
      new PolicyPipeline([new WhitelistPolicy(currentConfig.tools)]),
      new AuditLogger({ output: "stderr", level: "silent" }),
      manager,
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "wrapper-collision-host", version: "1.0.0" }, { capabilities: {} });
    await proxy.start(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      const names = listed.tools.map(({ name }) => name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain("mcp__get_schema");
      const catalogName = names.find((name) => name.startsWith("mcp__get_schema__sg_"));
      expect(catalogName).toBeDefined();

      await expect(
        client.callTool({
          name: catalogName!,
          arguments: { marker: "real-tool" },
        }),
      ).resolves.toEqual({
        content: [{ type: "text", text: "upstream:real-tool" }],
      });
      expect(connector.state("mcp_").calls).toEqual([{ toolName: "get_schema", args: { marker: "real-tool" } }]);

      const schema = await client.callTool({
        name: "mcp__get_schema",
        arguments: { tool_name: catalogName },
      });
      expect(schema.isError).not.toBe(true);
      expect(connector.state("mcp_").calls).toHaveLength(1);
    } finally {
      await client.close().catch(() => {});
      await proxy.stop().catch(() => {});
    }
  });
});
