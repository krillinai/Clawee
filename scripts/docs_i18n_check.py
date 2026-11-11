#!/usr/bin/env python3
from pathlib import Path
import re
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent

REQUIRED_PAIRS = (
    ("README.md", "docs/zh-CN/README.md"),
    ("docs/en/i18n.md", "docs/i18n.md"),
    ("docs/en/architecture.md", "docs/architecture.md"),
    ("docs/en/repository-maintenance.md", "docs/repository-maintenance.md"),
    ("docs/en/contributing.md", "CONTRIBUTING.md"),
    ("docs/en/security.md", "SECURITY.md"),
    ("server/docs/en/README.md", "server/docs/README.md"),
    ("server/docs/en/architecture/overview.md", "server/docs/architecture/overview.md"),
    ("server/docs/en/architecture/security-and-permissions.md", "server/docs/architecture/security-and-permissions.md"),
    ("server/docs/en/getting-started/development.md", "server/docs/getting-started/development.md"),
    ("server/docs/en/getting-started/configuration.md", "server/docs/getting-started/configuration.md"),
    ("server/docs/en/deployment/production.md", "server/docs/deployment/production.md"),
    ("server/docs/en/integration/clawee-agent.md", "server/docs/integration/clawee-agent.md"),
    ("server/docs/en/integration/upstream-mcp.md", "server/docs/integration/upstream-mcp.md"),
    ("server/docs/en/reference/http-api.md", "server/docs/reference/http-api.md"),
)

LINK_PATTERN = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
IMAGE_PATTERN = re.compile(r"(?:src|srcset)=\"([^\"]+)\"")
SKIP_PREFIXES = ("http://", "https://", "mailto:", "data:", "#")


def local_target(source, raw):
    raw = raw.strip().strip("<>")
    if not raw or raw.startswith(SKIP_PREFIXES):
        return None
    target = unquote(raw.split("#", 1)[0])
    if not target:
        return None
    return (source.parent / target).resolve()


def links_in(source):
    text = source.read_text(encoding="utf-8")
    for match in LINK_PATTERN.finditer(text):
        yield match.group(1)
    for match in IMAGE_PATTERN.finditer(text):
        yield match.group(1)


def check_document(path, errors):
    if not path.is_file():
        errors.append(f"缺少文档：{path.relative_to(ROOT)}")
        return
    text = path.read_text(encoding="utf-8")
    if not re.search(r"^#\s+\S", text, re.MULTILINE):
        errors.append(f"缺少一级标题：{path.relative_to(ROOT)}")
    fences = len(re.findall(r"^```", text, re.MULTILINE))
    if fences % 2:
        errors.append(f"代码块未闭合：{path.relative_to(ROOT)}")
    for raw in links_in(path):
        target = local_target(path, raw)
        if target is not None and not target.exists():
            errors.append(f"链接不存在：{path.relative_to(ROOT)} -> {raw}")


def check_pair(english_path, chinese_path, errors):
    english = ROOT / english_path
    chinese = ROOT / chinese_path
    check_document(english, errors)
    check_document(chinese, errors)
    if not english.is_file() or not chinese.is_file():
        return
    if not any(local_target(english, raw) == chinese for raw in links_in(english)):
        errors.append(f"缺少中文切换链接：{english_path}")
    if not any(local_target(chinese, raw) == english for raw in links_in(chinese)):
        errors.append(f"缺少英文切换链接：{chinese_path}")


def main():
    errors = []
    for english, chinese in REQUIRED_PAIRS:
        check_pair(english, chinese, errors)
    if errors:
        print("双语文档检查失败：", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(f"双语文档检查通过：{len(REQUIRED_PAIRS)} 组文档的语言链接、相对链接、图片和代码块均有效。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
