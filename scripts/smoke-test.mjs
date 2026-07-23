#!/usr/bin/env node
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD_CLI = path.resolve(__dirname, '../dist/cli.js');
const TEST_DIR = path.resolve(__dirname, '../test-workspace');

let requestId = 0;
function send(proc, method, params = {}) {
  const id = ++requestId;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return id;
}

function readResponse(proc, expectedId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout for request ${expectedId}`)), timeoutMs);
    function onData(data) {
      const line = data.toString().trim();
      if (!line) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id === expectedId) {
          clearTimeout(timer);
          proc.stdout.removeListener('data', onData);
          resolve(msg);
        }
      } catch (e) {}
    }
    proc.stdout.on('data', onData);
  });
}

async function test() {
  console.log('🚀 mcp-guard smoke test\n');

  // Always recreate workspace with fresh config
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(
      path.join(TEST_DIR, 'mcp-slim-guard.yml'),
      [
        'version: 1',
        '',
        'tools:',
        '  allow:',
        '    - "*"',
        '  deny:',
        '    - "*_delete_*"',
        '',
        'ssrf:',
        '  mode: log',
        '  block_private_ips: true',
        '  allow_domains: []',
        '  block_domains: []',
        '',
        'rate_limit:',
        '  default: "100/min"',
        '',
        'injection_detection:',
        '  enabled: false',
        '',
        'servers:',
        '  mock:',
        '    command: node',
        `    args: ["${path.resolve(__dirname, '../dist/mock-server.js')}"]`,
        '',
      ].join('\n'),
    );

  const proc = child_process.spawn('node', [GUARD_CLI, 'start'], {
    cwd: TEST_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', PATH: process.env.PATH },
  });

  const stderrChunks = [];
  proc.stderr.on('data', (d) => stderrChunks.push(d.toString()));

  let passed = 0, failed = 0;

  try {
    await new Promise(r => setTimeout(r, 800));
    if (proc.exitCode !== null) {
      console.error(`❌ Guard exited with code ${proc.exitCode}`);
      console.error('STDERR:', stderrChunks.join('').slice(0, 500));
      process.exit(1);
    }

    // Initialize
    const initId = send(proc, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' }
    });
    const initResp = await readResponse(proc, initId);
    console.log(`✅ initialize: ${initResp.result?.serverInfo?.name} v${initResp.result?.serverInfo?.version}`);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    // Wait for server discovery to complete before listing tools
    await new Promise(r => setTimeout(r, 2000));

    // 1. tools/list
    console.log('\n--- tools/list ---');
    {
      const id = send(proc, 'tools/list', {});
      const resp = await readResponse(proc, id);
      const tools = resp.result?.tools || [];
      console.log(`   Tools: ${tools.map(t => t.name).join(', ')}`);
      const ok = tools.some(t => t.name === 'mock_echo') && tools.some(t => t.name === 'mock_add') && tools.some(t => t.name === 'mock_get_time');
      console.log(ok ? '   ✅ All mock tools present' : '   ❌ Missing tools');
      ok ? passed++ : failed++;
    }

    // 2. tools/call mock_echo
    console.log('\n--- tools/call mock_echo ---');
    {
      const id = send(proc, 'tools/call', { name: 'mock_echo', arguments: { message: 'hello-guard' } });
      const resp = await readResponse(proc, id);
      if (resp.error) { console.log(`   ❌ Error: ${resp.error.message}`); failed++; }
      else {
        const text = resp.result?.content?.[0]?.text || '';
        console.log(`   Result: ${text}`);
        if (text.includes('hello-guard')) { console.log('   ✅ Echo passes through'); passed++; }
        else { console.log('   ❌ Unexpected result'); failed++; }
      }
    }

    // 3. tools/call mock_add
    console.log('\n--- tools/call mock_add ---');
    {
      const id = send(proc, 'tools/call', { name: 'mock_add', arguments: { a: 3, b: 7 } });
      const resp = await readResponse(proc, id);
      if (resp.error) { console.log(`   ❌ Error: ${resp.error.message}`); failed++; }
      else {
        const text = resp.result?.content?.[0]?.text || '';
        console.log(`   Result: ${text}`);
        if (text === '10') { console.log('   ✅ Add passes through'); passed++; }
        else { console.log(`   ❌ Expected 10, got "${text}"`); failed++; }
      }
    }

    // 4. tools/call mock_delete_something (SHOULD BE BLOCKED by deny: *_delete_*)
    console.log('\n--- tools/call mock_delete_something (denied) ---');
    {
      const id = send(proc, 'tools/call', { name: 'mock_delete_something', arguments: { target: 'all' } });
      const resp = await readResponse(proc, id);
      if (resp.error || resp.result?.isError) {
        const msg = resp.error?.message || resp.result?.content?.[0]?.text || '';
        console.log(`   Error: ${msg}`);
        if (msg.includes('deny') || msg.includes('not allowed') || msg.includes('blocked')) {
          console.log('   ✅ Denied tool correctly blocked'); passed++;
        } else { console.log('   ⚠️ Blocked but unexpected message'); failed++; }
      } else { console.log('   ❌ Should have been blocked'); failed++; }
    }

    // 5. get_time x3
    console.log('\n--- tools/call mock_get_time (x3) ---');
    {
      let ok = 0;
      for (let i = 0; i < 3; i++) {
        const id = send(proc, 'tools/call', { name: 'mock_get_time', arguments: {} });
        const resp = await readResponse(proc, id);
        if (resp.error) console.log(`   Call ${i+1}: ❌ ${resp.error.message}`);
        else { console.log(`   Call ${i+1}: ${resp.result?.content?.[0]?.text || ''}`); ok++; }
      }
      if (ok === 3) { console.log('   ✅ All 3 passed (rate limit OK)'); passed++; }
      else { console.log(`   ❌ ${3-ok} failed`); failed++; }
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`🏁 ${passed} passed, ${failed} failed`);
    console.log(failed === 0 ? '🎉 ALL SMOKE TESTS PASSED!' : '❌ SOME FAILED');

  } finally {
    proc.kill();
    await new Promise(r => setTimeout(r, 300));
  }
  process.exit(failed > 0 ? 1 : 0);
}

test().catch(err => { console.error('FATAL:', err); process.exit(1); });
