const pairs = [
  ["catalog", "search_catalog", { query: "adapter", locale: "en", limit: 3 }, "CATALOG:adapter:en", "Search the product catalog for adapter and return three English results.", "检索产品目录中的“适配器”，返回三个中文结果。"],
  ["report", "generate_report", { report_id: "RPT-42", locale: "en", detail: "full" }, "REPORT:RPT-42:en:END", "Generate the full RPT-42 operational report and verify its end marker.", "生成完整的 RPT-42 运营报告并核验末尾标记。"],
  ["product", "get_product", { product_id: "product-7", include_inventory: true }, "\"product_id\":\"product-7\"", "Get product-7 and include inventory.", "获取 product-7，并包含库存信息。"],
  ["customer", "lookup_customer", { customer_id: "customer-9", fields: ["name", "tier"] }, "\"customer_id\":\"customer-9\"", "Look up customer-9 and return name and tier.", "查询 customer-9，并返回姓名和等级。"],
  ["orders", "list_orders", { customer_id: "customer-9", status: "open", limit: 5 }, "\"customer_id\":\"customer-9\"", "List five open orders for customer-9.", "列出 customer-9 的五个未结订单。"],
  ["order", "get_order", { order_id: "order-21", include_history: true }, "\"order_id\":\"order-21\"", "Get order-21 including its history.", "获取 order-21，并包含历史记录。"],
  ["incidents", "list_incidents", { service: "billing", severity: "critical" }, "\"service\":\"billing\"", "List critical incidents for the billing service.", "列出 billing 服务的严重级别为 critical 的事件。"],
  ["ticket", "create_ticket", { title: "Checkout outage", description: "Checkout returns 503", priority: "urgent" }, "\"id\":\"ticket-fixed\"", "Create an urgent support ticket titled Checkout outage because checkout returns 503.", "创建紧急支持工单，标题为“结账故障”，说明结账返回 503。"],
  ["document", "read_document", { path: "docs/runbook.md", max_chars: 2000 }, "\"path\":\"docs/runbook.md\"", "Read at most 2000 characters from docs/runbook.md.", "读取 docs/runbook.md，最多返回 2000 个字符。"],
  ["translate", "translate_text", { text: "Deployment complete", target_language: "zh", preserve_formatting: true }, "\"target_language\":\"zh\"", "Translate 'Deployment complete' to Chinese and preserve formatting.", "把“部署完成”翻译成英文，并保留格式。"],
  ["budget", "calculate_budget", { currency: "USD", items: [{ label: "adapter", quantity: 2, unit_price: 25 }] }, "\"total\":50", "Calculate a USD budget for two adapters at 25 each.", "计算美元预算：两个适配器，每个 25 美元。"],
  ["events", "list_events", { calendar: "ops", start: "2026-07-27T09:00:00Z", end: "2026-07-27T17:00:00Z", timezone: "UTC" }, "\"calendar\":\"ops\"", "List events on the ops calendar from 09:00 to 17:00 UTC on 2026-07-27.", "列出 ops 日历在 2026-07-27 09:00 到 17:00 UTC 的事件。"],
];

export const MODEL_SELECTION_SCENARIOS = pairs.flatMap(
  ([id, tool, englishArguments, marker, english, chinese]) => {
    const chineseArguments = structuredClone(englishArguments);
    if (tool === "search_catalog") {
      chineseArguments.query = "适配器";
      chineseArguments.locale = "zh";
      marker = "CATALOG:适配器:zh";
    }
    if (tool === "generate_report") {
      chineseArguments.locale = "zh";
      marker = "REPORT:RPT-42:zh:END";
    }
    if (tool === "translate_text") {
      chineseArguments.text = "部署完成";
      chineseArguments.target_language = "en";
      marker = "\"target_language\":\"en\"";
    }
    return [
      {
        id: `en-${id}`,
        language: "en",
        prompt: english,
        tool,
        arguments: englishArguments,
        required: Object.keys(englishArguments),
        values: Object.fromEntries(Object.entries(englishArguments).filter(([, value]) => typeof value !== "object")),
        marker: pairs.find((entry) => entry[0] === id)[3],
      },
      {
        id: `zh-${id}`,
        language: "zh",
        prompt: chinese,
        tool,
        arguments: chineseArguments,
        required: Object.keys(chineseArguments),
        values: Object.fromEntries(Object.entries(chineseArguments).filter(([, value]) => typeof value !== "object")),
        marker,
      },
    ];
  },
);
