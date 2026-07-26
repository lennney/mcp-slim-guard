#!/usr/bin/env node

import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "slim-guard-task-fixture",
  version: "1.0.0",
});

function withInvocationAudit(toolName, handler) {
  return async (args) => {
    const auditPath = process.env.SLIM_GUARD_FIXTURE_AUDIT_PATH;
    if (auditPath) {
      fs.appendFileSync(auditPath, `${JSON.stringify({ tool: toolName, arguments: args })}\n`, "utf8");
    }
    return handler(args);
  };
}

server.registerTool(
  "search_catalog",
  {
    description: "Search the product catalog by keyword. 按关键词检索产品目录。",
    inputSchema: {
      query: z.string().min(1).describe("English or Chinese search query"),
      locale: z.enum(["en", "zh"]).describe("Response language"),
      limit: z.number().int().min(1).max(20).default(3).describe("Maximum result count"),
    },
  },
  withInvocationAudit("search_catalog", async ({ query, locale, limit }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          marker: `CATALOG:${query}:${locale}`,
          items: Array.from({ length: limit }, (_, index) => ({
            id: `product-${index + 1}`,
            title: `${query}-${index + 1}`,
          })),
        }),
      },
    ],
  })),
);

server.registerTool(
  "generate_report",
  {
    description: "Generate a detailed operational report. 生成详细运营报告。",
    inputSchema: {
      report_id: z.string().min(1).describe("Stable report identifier"),
      locale: z.enum(["en", "zh"]).describe("Report language"),
      detail: z.enum(["summary", "full"]).describe("Requested detail level"),
    },
  },
  withInvocationAudit("generate_report", async ({ report_id, locale, detail }) => {
    const line =
      locale === "zh"
        ? `报告 ${report_id} 的证据行，包含状态、来源、标识符与可恢复上下文。`
        : `Evidence line for report ${report_id} with status, provenance, identifiers, and recoverable context.`;
    const body =
      detail === "full" ? Array.from({ length: 700 }, (_, index) => `${index + 1}. ${line}`).join("\n") : line;
    const header = `REPORT:${report_id}:${locale}:BEGIN`;
    const marker = `REPORT:${report_id}:${locale}:END`;
    return {
      content: [{ type: "text", text: `${header}\n${body}\n${marker}` }],
    };
  }),
);

server.registerTool(
  "get_product",
  {
    description: "Get one product and optional inventory details. 获取产品及库存详情。",
    inputSchema: {
      product_id: z.string().describe("Product identifier"),
      include_inventory: z.boolean().default(false).describe("Include inventory"),
    },
  },
  withInvocationAudit("get_product", async ({ product_id, include_inventory }) => ({
    content: [{ type: "text", text: JSON.stringify({ product_id, include_inventory }) }],
  })),
);

server.registerTool(
  "lookup_customer",
  {
    description: "Look up an authorized customer profile. 查询已授权客户资料。",
    inputSchema: {
      customer_id: z.string().describe("Customer identifier"),
      fields: z.array(z.string()).max(10).optional().describe("Requested profile fields"),
    },
  },
  withInvocationAudit("lookup_customer", async ({ customer_id, fields }) => ({
    content: [{ type: "text", text: JSON.stringify({ customer_id, fields: fields ?? [] }) }],
  })),
);

server.registerTool(
  "list_orders",
  {
    description: "List orders with bounded filters. 按条件列出订单。",
    inputSchema: {
      customer_id: z.string().describe("Customer identifier"),
      status: z.enum(["open", "closed", "cancelled"]).optional().describe("Order status"),
      limit: z.number().int().min(1).max(100).default(20).describe("Maximum results"),
    },
  },
  withInvocationAudit("list_orders", async ({ customer_id, status, limit }) => ({
    content: [{ type: "text", text: JSON.stringify({ customer_id, status, limit, orders: [] }) }],
  })),
);

server.registerTool(
  "get_order",
  {
    description: "Get an order with optional history. 获取订单及历史。",
    inputSchema: {
      order_id: z.string().describe("Order identifier"),
      include_history: z.boolean().default(false).describe("Include status history"),
    },
  },
  withInvocationAudit("get_order", async ({ order_id, include_history }) => ({
    content: [{ type: "text", text: JSON.stringify({ order_id, include_history }) }],
  })),
);

server.registerTool(
  "list_incidents",
  {
    description: "List service incidents by severity. 按严重程度列出服务事件。",
    inputSchema: {
      service: z.string().describe("Service name"),
      severity: z.enum(["low", "medium", "high", "critical"]).optional().describe("Severity filter"),
      since: z.string().optional().describe("ISO-8601 lower time bound"),
    },
  },
  withInvocationAudit("list_incidents", async ({ service, severity, since }) => ({
    content: [{ type: "text", text: JSON.stringify({ service, severity, since, incidents: [] }) }],
  })),
);

server.registerTool(
  "create_ticket",
  {
    description: "Create a support ticket. 创建支持工单。",
    inputSchema: {
      title: z.string().min(1).describe("Ticket title"),
      description: z.string().min(1).describe("Ticket description"),
      priority: z.enum(["low", "normal", "high", "urgent"]).describe("Ticket priority"),
    },
  },
  withInvocationAudit("create_ticket", async ({ title, priority }) => ({
    content: [{ type: "text", text: JSON.stringify({ id: "ticket-fixed", title, priority }) }],
  })),
);

server.registerTool(
  "read_document",
  {
    description: "Read a bounded document snapshot. 读取有界文档快照。",
    inputSchema: {
      path: z.string().describe("Document path"),
      max_chars: z.number().int().min(1).max(50_000).default(10_000).describe("Character budget"),
    },
  },
  withInvocationAudit("read_document", async ({ path, max_chars }) => ({
    content: [{ type: "text", text: JSON.stringify({ path, max_chars, text: "fixture document" }) }],
  })),
);

server.registerTool(
  "translate_text",
  {
    description: "Translate text to a target language. 将文本翻译为目标语言。",
    inputSchema: {
      text: z.string().min(1).describe("Source text"),
      target_language: z.string().min(2).describe("Target language"),
      preserve_formatting: z.boolean().default(true).describe("Preserve formatting"),
    },
  },
  withInvocationAudit("translate_text", async ({ text, target_language, preserve_formatting }) => ({
    content: [{ type: "text", text: JSON.stringify({ text, target_language, preserve_formatting }) }],
  })),
);

server.registerTool(
  "calculate_budget",
  {
    description: "Calculate a budget from typed line items. 根据结构化条目计算预算。",
    inputSchema: {
      currency: z.string().length(3).describe("ISO currency code"),
      items: z
        .array(
          z.object({
            label: z.string(),
            quantity: z.number().positive(),
            unit_price: z.number().nonnegative(),
          }),
        )
        .min(1)
        .describe("Budget line items"),
    },
  },
  withInvocationAudit("calculate_budget", async ({ currency, items }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          currency,
          total: items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0),
        }),
      },
    ],
  })),
);

server.registerTool(
  "list_events",
  {
    description: "List calendar events within a time window. 列出时间窗口内的日历事件。",
    inputSchema: {
      calendar: z.string().describe("Calendar identifier"),
      start: z.string().describe("ISO-8601 start time"),
      end: z.string().describe("ISO-8601 end time"),
      timezone: z.string().default("UTC").describe("IANA timezone"),
    },
  },
  withInvocationAudit("list_events", async ({ calendar, start, end, timezone }) => ({
    content: [{ type: "text", text: JSON.stringify({ calendar, start, end, timezone, events: [] }) }],
  })),
);

await server.connect(new StdioServerTransport());
