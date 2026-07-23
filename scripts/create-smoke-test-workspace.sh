#!/usr/bin/env bash
# Create smoke test workspace with a minimal micro-mcp.yml config.
set -euo pipefail

WORKSPACE_DIR="$(dirname "$0")/../test-workspace"
mkdir -p "$WORKSPACE_DIR"

cat > "$WORKSPACE_DIR/micro-mcp.yml" << 'YAML'
version: 1
tools:
  allow:
    - "*"
  deny:
    - "*_delete_*"
ssrf:
  mode: off
  block_private_ips: false
  allow_domains: []
  block_domains: []
rate_limit:
  default: ""
injection_detection:
  enabled: false
compressor:
  enabled: false
  level: "light"
servers:
  mock:
    command: node
    args:
      - "../dist/mock-server.js"
    env: {}
audit:
  output: stdout
YAML

echo "Created $WORKSPACE_DIR/micro-mcp.yml"
