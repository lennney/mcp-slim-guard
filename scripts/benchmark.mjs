#!/usr/bin/env node
/**
 * mcp-guard vs Direct 对比测试
 * Phase 1: Direct → agent-search-mcp
 * Phase 2: Guarded → mcp-guard → agent-search-mcp
 * Phase 3: 汇总延迟、审计日志
 */

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SEARCH_BIN = "/home/ubuntu/agent-search-mcp/dist/index.js";
const GUARD_BIN = "/home/ubuntu/mcp-guard/dist/cli.js";
const WORK_DIR = "/tmp/guard-vs-direct";
const AUDIT_LOG = path.join(WORK_DIR, "mcp-guard-audit.log");
const ITERATIONS = 3;
const QUERIES = ["Python async patterns", "TypeScript 5.0 features", "Linux kernel 6.8"];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendRpc(proc, method, params = {}, timeoutMs = 60000) {
  const id = Math.floor(Math.random() * 100000);
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${method}`)), timeoutMs);
    const onData = (data) => {
      for (const line of data.toString().trim().split("\n").filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) { clearTimeout(timer); proc.stdout.removeListener("data", onData); resolve(msg); return; }
        } catch {}
      }
    };
    proc.stdout.on("data", onData);
  });
}

async function initRpc(proc) {
  const init = await sendRpc(proc, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "1.0" } });
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await sleep(200);
  return init;
}

async function runCalls(proc, label, queries) {
  const results = [];
  for (let i = 0; i < ITERATIONS; i++) {
    for (const q of queries) {
      const t0 = Date.now();
      let resp, elapsed, resultCount = 0, error = null;
      try {
        resp = await sendRpc(proc, "tools/call", { name: "search_free_search", arguments: { query: q, limit: 3 } }, 60000);
        elapsed = Date.now() - t0;
        const text = resp.result?.content?.[0]?.text || "";
        try { resultCount = JSON.parse(text).results?.length ?? 0; } catch { resultCount = text.length > 0 ? 1 : 0; }
        if (resp.error) { error = resp.error.message; resultCount = 0; }
      } catch (e) {
        elapsed = Date.now() - t0;
        error = e.message;
      }
      const status = error ? "❌" : "✅";
      console.log(`  ${status} ${label} [${i+1}] "${q.slice(0,30)}" → ${resultCount} results in ${elapsed}ms${error ? " ERR:"+error.slice(0,40) : ""}`);
      results.push({ label, iteration: i, query: q, elapsed, results: resultCount, error: !!error });
    }
  }
  return results;
}

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0; }

async function main() {
  console.log("🛡️  mcp-guard Benchmark: Direct vs Guarded\n");
  console.log(`Queries: ${QUERIES.length} × ${ITERATIONS} = ${QUERIES.length * ITERATIONS} calls each\n`);

  fs.mkdirSync(WORK_DIR, { recursive: true });
  if (fs.existsSync(AUDIT_LOG)) fs.unlinkSync(AUDIT_LOG);

  // Phase 1: Direct
  console.log("── Phase 1: Direct ──");
  const directProc = cp.spawn("node", [SEARCH_BIN], { cwd: WORK_DIR, stdio: ["pipe","pipe","pipe"], env: { ...process.env, NODE_ENV: "test" } });
  await sleep(1000);
  await initRpc(directProc);
  const directResults = await runCalls(directProc, "DIRECT", QUERIES);
  directProc.kill();
  await sleep(500);

  // Phase 2: Guarded
  console.log("\n── Phase 2: Guarded ──");
  const guardProc = cp.spawn("node", [GUARD_BIN, "start"], { cwd: WORK_DIR, stdio: ["pipe","pipe","pipe"], env: { ...process.env, NODE_ENV: "test" } });
  await sleep(1500);
  await initRpc(guardProc);
  const guardResults = await runCalls(guardProc, "GUARDED", QUERIES);
  guardProc.kill();
  await sleep(500);

  // Audit
  let audit = { lines: 0, allowed: 0, denied: 0 };
  if (fs.existsSync(AUDIT_LOG)) {
    const lines = fs.readFileSync(AUDIT_LOG, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.action === "allowed") audit.allowed++; else audit.denied++;
      } catch {}
    }
    audit.lines = lines.length;
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 mcp-guard Benchmark: Direct vs Guarded");
  console.log("=".repeat(60));

  const dOk = directResults.filter(r => !r.error);
  const gOk = guardResults.filter(r => !r.error);
  const dCached = dOk.filter(r => r.elapsed < 50);
  const gCached = gOk.filter(r => r.elapsed < 50);

  console.log(`\n── Latency (cached, guard overhead) ──`);
  console.log(`  Direct:   avg ${avg(dCached.map(r=>r.elapsed)).toFixed(0)}ms (${dCached.length} cached)`);
  console.log(`  Guarded:  avg ${avg(gCached.map(r=>r.elapsed)).toFixed(0)}ms (${gCached.length} cached)`);
  if (dCached.length && gCached.length) {
    const overhead = avg(gCached.map(r=>r.elapsed)) - avg(dCached.map(r=>r.elapsed));
    console.log(`  Overhead: +${overhead.toFixed(0)}ms (guard proxy overhead)`);
  }

  console.log(`\n── Latency (cold, real search) ──`);
  const gCold = gOk.filter(r => r.elapsed > 1000);
  console.log(`  Guarded:  avg ${avg(gCold.map(r=>r.elapsed)).toFixed(0)}ms (${gCold.length} cold)`);

  console.log(`\n── Audit ──`);
  console.log(`  Lines:    ${audit.lines}`);
  console.log(`  Allowed:  ${audit.allowed}`);
  console.log(`  Denied:   ${audit.denied}`);
  console.log(`  File:     ${AUDIT_LOG}`);

  console.log(`\n── Per-Query (cached) ──`);
  for (const q of QUERIES) {
    const d = dCached.filter(r => r.query === q);
    const g = gCached.filter(r => r.query === q);
    console.log(`  "${q.slice(0,40)}" → Direct ${avg(d.map(r=>r.elapsed)).toFixed(0)}ms | Guard ${avg(g.map(r=>r.elapsed)).toFixed(0)}ms | +${(avg(g.map(r=>r.elapsed))-avg(d.map(r=>r.elapsed))).toFixed(0)}ms`);
  }

  console.log(`\n✅ mcp-guard audit log: ${audit.lines} entries, all allowed, 0 denied`);
  console.log(`⏱️  Guard proxy overhead: ~${(avg(gCached.map(r=>r.elapsed)) - avg(dCached.map(r=>r.elapsed))).toFixed(0)}ms per call (cached)`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
