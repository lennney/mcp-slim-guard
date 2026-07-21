#!/usr/bin/env python3
"""
Batch-add OKF frontmatter to all project documentation files.

Scans all projects, adds frontmatter based on filename and project context.
Creates missing CHANGELOG.md files with basic template.
Does NOT overwrite existing frontmatter.
"""
import os
import re
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=8))  # Asia/Shanghai
NOW = datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S+08:00")

PROJECTS = {
    "baby-harness": {
        "name": "Baby Harness",
        "tag": "baby-harness",
        "subtitle": "自治 AI Agent 任务执行框架",
        "desc": "给 Agent 一个目标，它自己干到完，越干越熟",
    },
    "agent-search-mcp": {
        "name": "Agent Search MCP",
        "tag": "agent-search-mcp",
        "subtitle": "多引擎统一搜索 MCP Server",
        "desc": "7 引擎搜索，MCP 协议接入，免费 + 多源验证 + Token 优化",
    },
    "crawlweaver": {
        "name": "CrawlWeaver",
        "tag": "crawlweaver",
        "subtitle": "自进化 AI 爬虫",
        "desc": "URL → 提取 → AI 改写 → SEO 优化 → 渲染 HTML → 自检评分",
    },
    "gh.l-web": {
        "name": "gh.l-web",
        "tag": "gh-l-web",
        "subtitle": "个人技术博客",
        "desc": "Next.js 16 + MDX 技术博客，AI 内容管线",
    },
    "headroom": {
        "name": "headroom",
        "tag": "headroom",
        "subtitle": "AI Proxy — OSS 贡献",
        "desc": "headroomlabs-ai/headroom OSS 项目",
    },
    "agent-workspace-refarch": {
        "name": "Agent Workspace Reference Architecture",
        "tag": "agent-workspace-refarch",
        "subtitle": "多项目工作区模板",
        "desc": "AI agent 多项目工作空间的上下文工程模板",
    },
}

FRONTMATTER_TEMPLATE = """---
type: {doc_type}
title: {title}
timestamp: '{timestamp}'
description: {description}
tags:
- {project_tag}
- {type_tag}
---
"""

CHANGELOG_TEMPLATE = """---
type: Changelog
title: {name} CHANGELOG
timestamp: '{timestamp}'
description: 版本变更记录
tags:
- {project_tag}
- changelog
---

# Changelog

## [0.1.0] — 2026-07-20

### Added
- Initial release
"""

DOC_TYPES = {
    "AGENTS.md": ("AgentInstruction", "agentinstruction"),
    "HANDOVER.md": ("HandoverDoc", "handoverdoc"),
    "LEARNINGS.md": ("Learnings", "learnings"),
    "README.md": ("Readme", "readme"),
    "CHANGELOG.md": ("Changelog", "changelog"),
}

DOC_TITLES = {
    "AGENTS.md": lambda p: f"{p['name']} — {p['subtitle']}",
    "HANDOVER.md": lambda p: f"{p['tag']} HANDOVER",
    "LEARNINGS.md": lambda p: f"{p['tag']} LEARNINGS",
    "README.md": lambda p: p['name'],
    "CHANGELOG.md": lambda p: f"{p['name']} CHANGELOG",
}

DOC_DESCRIPTIONS = {
    "AGENTS.md": lambda p: p['desc'],
    "HANDOVER.md": lambda p: "会话日志和项目状态",
    "LEARNINGS.md": lambda p: "技术教训和踩坑记录",
    "README.md": lambda p: p['desc'],
    "CHANGELOG.md": lambda p: "版本变更记录",
}


def has_frontmatter(content: str) -> bool:
    """Check if file already has YAML frontmatter."""
    return content.startswith("---\n") and "\n---\n" in content[:500]


def add_frontmatter(filepath: str, proj_key: str, filename: str):
    """Add frontmatter to a file if it doesn't have one."""
    with open(filepath, "r") as f:
        content = f.read()

    if has_frontmatter(content):
        print(f"  SKIP {filename} — already has frontmatter")
        return False

    p = PROJECTS[proj_key]
    doc_type, type_tag = DOC_TYPES[filename]
    title = DOC_TITLES[filename](p)
    desc = DOC_DESCRIPTIONS[filename](p)

    fm = FRONTMATTER_TEMPLATE.format(
        doc_type=doc_type,
        title=title,
        timestamp=NOW,
        description=desc,
        project_tag=p['tag'],
        type_tag=type_tag,
    )

    with open(filepath, "w") as f:
        f.write(fm + content)

    print(f"  ✅ {filename} — added OKF frontmatter")
    return True


def create_changelog(proj_dir: str, proj_key: str):
    """Create CHANGELOG.md if missing."""
    path = os.path.join(proj_dir, "CHANGELOG.md")
    if os.path.exists(path):
        return False

    p = PROJECTS[proj_key]
    content = CHANGELOG_TEMPLATE.format(
        name=p['name'],
        timestamp=NOW,
        project_tag=p['tag'],
    )
    with open(path, "w") as f:
        f.write(content)
    print(f"  ✅ CHANGELOG.md — created (new)")
    return True


def main():
    base = os.path.expanduser("~")
    for proj_key in PROJECTS:
        proj_dir = os.path.join(base, proj_key)
        if not os.path.isdir(proj_dir):
            print(f"\n=== {proj_key} (NOT FOUND) ===")
            continue

        print(f"\n=== {proj_key} ===")
        # Add frontmatter to existing files
        for filename in ["AGENTS.md", "HANDOVER.md", "LEARNINGS.md", "README.md", "CHANGELOG.md"]:
            filepath = os.path.join(proj_dir, filename)
            if os.path.exists(filepath):
                add_frontmatter(filepath, proj_key, filename)
            else:
                print(f"  · {filename} — missing")

        # Create CHANGELOG.md if missing
        create_changelog(proj_dir, proj_key)

        # Check HANDOVER line count
        handover_path = os.path.join(proj_dir, "HANDOVER.md")
        if os.path.exists(handover_path):
            with open(handover_path) as f:
                lines = len(f.readlines())
            status = "⚠️ OVER 80" if lines > 80 else "✅"
            print(f"  HANDOVER.md: {lines}L {status}")


if __name__ == "__main__":
    main()
