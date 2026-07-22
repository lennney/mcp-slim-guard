/**
 * Benchmark shared fixtures — tool discovery, scenario definitions, constants.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fs from "node:fs";

/** Compression levels to test */
export const LEVELS = ["off", "light", "normal", "extreme", "maximum"];

/** Number of runs per scenario × level for accuracy test */
export const RUNS = 3;

/** MCP server sources for tool discovery */
export const TOOL_SOURCES = [
  {
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/bench-workspace"],
    env: {},
    required: false, // skip if unavailable
  },
  {
    name: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {},
    required: false, // skip if no GITHUB_TOKEN
  },
];

/**
 * Test scenarios for accuracy benchmark.
 * 8 basic (single-tool) + 4 ambiguous (overlapping tool signatures).
 */
export const SCENARIOS = [
  // --- Basic single-tool scenarios (1-8) ---
  {
    id: 1,
    prompt: "Read the file at /tmp/bench-workspace/test.txt",
    expectedTool: "read_file",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: { path: "/tmp/bench-workspace/test.txt" },
    category: "basic",
  },
  {
    id: 2,
    prompt: "List the contents of /tmp/bench-workspace",
    expectedTool: "list_directory",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: { path: "/tmp/bench-workspace" },
    category: "basic",
  },
  {
    id: 3,
    prompt: 'Search for files matching "config" in /tmp/bench-workspace',
    expectedTool: "search_files",
    expectedArgs: { path: "string", pattern: "string" },
    requiredArgs: ["path", "pattern"],
    expectedValues: { path: "/tmp/bench-workspace", pattern: "config" },
    category: "basic",
  },
  {
    id: 4,
    prompt: "Get file info/metadata for /tmp/bench-workspace/test.txt",
    expectedTool: "get_file_info",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: { path: "/tmp/bench-workspace/test.txt" },
    category: "basic",
  },
  {
    id: 5,
    prompt: "Show the directory tree of /tmp/bench-workspace/src",
    expectedTool: "directory_tree",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: { path: "/tmp/bench-workspace/src" },
    category: "basic",
  },
  {
    id: 6,
    prompt: 'Write "hello world" to /tmp/bench-workspace/output.txt',
    expectedTool: "write_file",
    expectedArgs: { path: "string", content: "string" },
    requiredArgs: ["path", "content"],
    expectedValues: { path: "/tmp/bench-workspace/output.txt", content: "hello world" },
    category: "basic",
  },
  {
    id: 7,
    prompt: "Create a new directory at /tmp/bench-workspace/newdir",
    expectedTool: "create_directory",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: { path: "/tmp/bench-workspace/newdir" },
    category: "basic",
  },
  {
    id: 8,
    prompt: "Move /tmp/bench-workspace/a.txt to /tmp/bench-workspace/b.txt",
    expectedTool: "move_file",
    expectedArgs: { source: "string", destination: "string" },
    requiredArgs: ["source", "destination"],
    expectedValues: { source: "/tmp/bench-workspace/a.txt", destination: "/tmp/bench-workspace/b.txt" },
    category: "basic",
  },
  // --- Ambiguous scenarios (9-12) ---
  {
    id: 9,
    prompt: 'Find files containing "log" in /tmp/bench-workspace',
    expectedTool: "search_files",
    expectedArgs: { path: "string", pattern: "string" },
    requiredArgs: ["path", "pattern"],
    expectedValues: { pattern: "log" },
    category: "ambiguous",
    note: "read_file vs search_files — prompt says 'find files containing', expect search",
  },
  {
    id: 10,
    prompt: "Show all files recursively in /tmp/bench-workspace",
    expectedTool: "directory_tree",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: {},
    category: "ambiguous",
    note: "list_directory vs directory_tree — 'recursively' implies tree",
  },
  {
    id: 11,
    prompt: 'Make a new file /tmp/bench-workspace/x.txt with content "hi"',
    expectedTool: "write_file",
    expectedArgs: { path: "string", content: "string" },
    requiredArgs: ["path", "content"],
    expectedValues: { path: "/tmp/bench-workspace/x.txt", content: "hi" },
    category: "ambiguous",
    note: "write_file vs create_directory — 'file with content' implies write",
  },
  {
    id: 12,
    prompt: 'Search GitHub repositories for "mcp"',
    expectedTool: "search_repositories",
    expectedArgs: { query: "string" },
    requiredArgs: ["query"],
    expectedValues: { query: "mcp" },
    category: "ambiguous",
    note: "GitHub-specific — tests cross-server tool selection",
  },
];

/**
 * Start an MCP server, list tools, and close it.
 * Returns array of Tool objects, or empty array if server unavailable.
 */
export async function fetchTools(source) {
  const { name, command, args, env } = source;

  try {
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...env },
    });
    const client = new Client(
      { name: "benchmark", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    await transport.close();

    // Prefix tool names with server name: read_file → filesystem_read_file
    return tools.map((t) => ({
      ...t,
      name: `${name}_${t.name}`,
    }));
  } catch (err) {
    console.warn(`  ⚠️  ${name} server unavailable: ${err.message}`);
    return [];
  }
}

/**
 * Fetch tools from all available sources.
 * Skips unavailable servers (filesystem without npx, github without token).
 */
export async function fetchAllTools() {
  const allTools = [];
  for (const source of TOOL_SOURCES) {
    // Skip GitHub if no token
    if (source.name === "github" && !process.env.GITHUB_TOKEN) {
      console.warn(`  ⚠️  Skipping github server (no GITHUB_TOKEN)`);
      continue;
    }
    const tools = await fetchTools(source);
    console.log(`  📦 ${source.name}: ${tools.length} tools`);
    allTools.push(...tools);
  }
  return allTools;
}

/**
 * Prepare workspace directory for filesystem server.
 */
export function prepareWorkspace() {
  const dir = "/tmp/bench-workspace";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/test.txt`, "benchmark test file");
  fs.mkdirSync(`${dir}/src`, { recursive: true });
  return dir;
}
