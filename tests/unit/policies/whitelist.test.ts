import { describe, it, expect } from "vitest";
import { WhitelistPolicy } from "../../../src/policies/whitelist.js";
import type { PolicyContext } from "../../../src/types.js";

describe("WhitelistPolicy", () => {
  const config = {
    allow: ["github_*", "playwright_*", "filesystem_*"],
    deny: ["*_delete_*", "*_admin_*"],
    param_restrictions: {
      github_search_repositories: {
        q: { max_length: 200 },
      },
      github_create_issue: {
        title: { required: true },
      },
    },
  };

  const policy = new WhitelistPolicy(config);

  function ctx(
    toolName: string,
    args: Record<string, unknown> = {},
  ): PolicyContext {
    return { toolName, arguments: args, serverName: "test" };
  }

  it("allows tool matching allow pattern", async () => {
    const result = await policy.check(ctx("github_search_repositories"));
    expect(result.allowed).toBe(true);
  });

  it("denies tool not in allow list", async () => {
    const result = await policy.check(ctx("unknown_tool"));
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("not in allow list");
    }
  });

  it("denies tool matching deny pattern", async () => {
    const result = await policy.check(ctx("github_delete_repo"));
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("matches deny pattern");
    }
  });

  it("denies when required param missing", async () => {
    const result = await policy.check(
      ctx("github_create_issue", { body: "hello" }),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("Required param");
    }
  });

  it("allows when required param present", async () => {
    const result = await policy.check(
      ctx("github_create_issue", { title: "Fix bug" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("denies when param exceeds max_length", async () => {
    const longQuery = "a".repeat(201);
    const result = await policy.check(
      ctx("github_search_repositories", { q: longQuery }),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("exceeds max length");
    }
  });

  it("allows glob patterns with asterisk", async () => {
    const result = await policy.check(ctx("filesystem_read_file"));
    expect(result.allowed).toBe(true);
  });

  it("denies deny pattern even if allow also matches", async () => {
    // 添加一个同时匹配 allow 的 deny 模式
    const cfg = {
      ...config,
      allow: [...config.allow, "*_delete_*"],
    };
    const p = new WhitelistPolicy(cfg);
    const result = await p.check(ctx("github_delete_repo"));
    expect(result.allowed).toBe(false);
  });

  it("respects param pattern restriction", async () => {
    const cfg = {
      ...config,
      param_restrictions: {
        ...config.param_restrictions,
        github_test_tool: {
          url: { pattern: "^https?://" },
        },
      },
    };
    const p = new WhitelistPolicy(cfg);
    const valid = await p.check(
      ctx("github_test_tool", { url: "https://example.com" }),
    );
    expect(valid.allowed).toBe(true);

    const invalid = await p.check(
      ctx("github_test_tool", { url: "ftp://example.com" }),
    );
    expect(invalid.allowed).toBe(false);
  });
});
