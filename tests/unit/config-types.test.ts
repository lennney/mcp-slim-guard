import { describe, it, expect } from "vitest";
import type {
  GuardConfig,
  ToolsConfig,
  SSRFConfig,
  RateLimitConfig,
  UpstreamServer,
  ParamRule,
  InjectionConfig,
} from "../../src/config-types.js";

describe("GuardConfig", () => {
  it("should have correct structure with version 1", () => {
    const config: GuardConfig = {
      version: 1,
      tools: {
        allow: ["*"],
        deny: [],
        param_restrictions: {
          "github_search_repositories": {
            q: {
              max_length: 200,
              required: true,
              pattern: "^[a-zA-Z]+$",
            },
          },
        },
      },
      ssrf: {
        mode: "block",
        block_private_ips: true,
        allow_domains: ["api.github.com"],
        block_domains: ["169.254.169.254"],
      },
      rate_limit: {
        default: 100,
        per_agent: {
          "agent-1": { window_ms: 60_000, max_requests: 10 },
        },
      },
      injection_detection: {
        enabled: true,
        sensitivity: "medium",
      },
      servers: {
        github: {
          command: "node",
          args: ["mcp-server-github.js"],
          env: { GITHUB_TOKEN: "xxx" },
        },
      },
    };

    expect(config.version).toBe(1);
    expect(config.tools.allow).toEqual(["*"]);
    expect(config.tools.deny).toEqual([]);
    expect(config.ssrf.mode).toBe("block");
    expect(config.rate_limit.default).toBe(100);
    expect(config.injection_detection.enabled).toBe(true);
    expect(config.servers.github.command).toBe("node");
  });

  it("should accept empty servers and restrictions", () => {
    const config: GuardConfig = {
      version: 1,
      tools: { allow: [], deny: [] },
      ssrf: {
        mode: "off",
        block_private_ips: false,
        allow_domains: [],
        block_domains: [],
      },
      rate_limit: { default: 50 },
      injection_detection: { enabled: false },
      servers: {},
    };

    expect(config.version).toBe(1);
    expect(config.tools.allow).toEqual([]);
    expect(config.tools.deny).toEqual([]);
    expect(config.ssrf.mode).toBe("off");
    expect(config.rate_limit.default).toBe(50);
    expect(config.injection_detection.enabled).toBe(false);
    expect(Object.keys(config.servers)).toHaveLength(0);
  });
});

describe("ToolsConfig", () => {
  it("should support allow patterns", () => {
    const config: ToolsConfig = {
      allow: ["github_*", "filesystem_*"],
      deny: [],
    };
    expect(config.allow).toContain("github_*");
    expect(config.allow).toContain("filesystem_*");
  });

  it("should support deny patterns overriding allow", () => {
    const config: ToolsConfig = {
      allow: ["*"],
      deny: ["filesystem_write*"],
    };
    expect(config.allow).toEqual(["*"]);
    expect(config.deny).toEqual(["filesystem_write*"]);
  });

  it("should support param_restrictions", () => {
    const rule: ParamRule = {
      max_length: 500,
      required: true,
      pattern: "^https?://",
    };
    const config: ToolsConfig = {
      allow: ["*"],
      deny: [],
      param_restrictions: {
        fetch_url: {
          url: rule,
        },
      },
    };
    expect(config.param_restrictions!.fetch_url.url.max_length).toBe(500);
    expect(config.param_restrictions!.fetch_url.url.required).toBe(true);
    expect(config.param_restrictions!.fetch_url.url.pattern).toBe("^https?://");
  });
});

describe("SSRFConfig", () => {
  it("should accept 'block' mode", () => {
    const config: SSRFConfig = {
      mode: "block",
      block_private_ips: true,
      allow_domains: [],
      block_domains: [],
    };
    expect(config.mode).toBe("block");
  });

  it("should accept 'log' mode", () => {
    const config: SSRFConfig = {
      mode: "log",
      block_private_ips: true,
      allow_domains: [],
      block_domains: [],
    };
    expect(config.mode).toBe("log");
  });

  it("should accept 'off' mode", () => {
    const config: SSRFConfig = {
      mode: "off",
      block_private_ips: false,
      allow_domains: [],
      block_domains: [],
    };
    expect(config.mode).toBe("off");
  });

  it("should support allow and block domain lists", () => {
    const config: SSRFConfig = {
      mode: "block",
      block_private_ips: true,
      allow_domains: ["api.example.com", "*.trusted.com"],
      block_domains: ["malicious.com", "internal.corp"],
    };
    expect(config.allow_domains).toHaveLength(2);
    expect(config.block_domains).toHaveLength(2);
  });
});

describe("RateLimitConfig", () => {
  it("should accept number format for default", () => {
    const config: RateLimitConfig = {
      default: 100,
    };
    expect(config.default).toBe(100);
    expect(typeof config.default).toBe("number");
  });

  it("should accept object format for default with window and max_requests", () => {
    const config: RateLimitConfig = {
      default: { window_ms: 60_000, max_requests: 30 },
    };
    expect(typeof config.default).toBe("object");
    if (typeof config.default === "object") {
      expect(config.default.window_ms).toBe(60_000);
      expect(config.default.max_requests).toBe(30);
    }
  });

  it("should support per_agent overrides with mixed formats", () => {
    const config: RateLimitConfig = {
      default: 50,
      per_agent: {
        "agent-1": { window_ms: 10_000, max_requests: 5 },
        "agent-2": 200,
      },
    };
    expect(config.per_agent!["agent-1"]).toEqual({ window_ms: 10_000, max_requests: 5 });
    expect(config.per_agent!["agent-2"]).toBe(200);
  });
});

describe("UpstreamServer", () => {
  it("should support command, args and env", () => {
    const server: UpstreamServer = {
      command: "node",
      args: ["server.js", "--port", "3100"],
      env: { API_KEY: "test" },
    };
    expect(server.command).toBe("node");
    expect(server.args).toContain("server.js");
    expect(server.env.API_KEY).toBe("test");
  });
});

describe("InjectionConfig", () => {
  it("should be configurable with sensitivity levels", () => {
    const low: InjectionConfig = { enabled: true, sensitivity: "low" };
    const medium: InjectionConfig = { enabled: true, sensitivity: "medium" };
    const high: InjectionConfig = { enabled: true, sensitivity: "high" };
    const disabled: InjectionConfig = { enabled: false };

    expect(low.sensitivity).toBe("low");
    expect(medium.sensitivity).toBe("medium");
    expect(high.sensitivity).toBe("high");
    expect(disabled.enabled).toBe(false);
  });
});
