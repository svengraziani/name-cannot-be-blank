#!/usr/bin/env python3
"""
Scrapling bridge script for Node.js integration.

Accepts a JSON command on stdin, performs web browsing via Scrapling's
StealthyFetcher (Camoufox-based anti-detection browser), and returns
JSON results on stdout.

Supported actions: get_content, click, fill, evaluate
"""

import json
import sys

from scrapling.fetchers import StealthyFetcher


MAX_TEXT_LENGTH = 15000


def truncate(text: str, limit: int = MAX_TEXT_LENGTH) -> str:
    if len(text) > limit:
        return text[:limit] + "\n...(truncated)"
    return text


def handle_get_content(url: str, wait_for: str | None = None) -> dict:
    """Fetch a page and return its text content."""
    page = StealthyFetcher.fetch(
        url,
        headless=True,
        network_idle=True,
        wait_selector=wait_for,
    )
    title = page.css_first("title")
    title_text = title.text if title else ""
    body = page.get_all_text(separator="\n", strip=True)
    return {
        "content": f"Page: {title_text}\nURL: {url}\nStatus: {page.status}\n\n{truncate(body)}"
    }


def handle_click(url: str, selector: str, wait_for: str | None = None) -> dict:
    """Navigate to a page, click a selector, and return the resulting content."""
    if not selector:
        return {"content": "Error: selector is required for click action", "isError": True}

    def click_action(page):
        if wait_for:
            page.wait_for_selector(wait_for, timeout=10000)
        page.click(selector)
        page.wait_for_timeout(1500)
        return page

    page = StealthyFetcher.fetch(
        url,
        headless=True,
        network_idle=True,
        page_action=click_action,
    )
    title = page.css_first("title")
    title_text = title.text if title else ""
    body = page.get_all_text(separator="\n", strip=True)
    return {
        "content": f'Clicked "{selector}"\nPage: {title_text}\nURL: {url}\n\n{truncate(body, 10000)}'
    }


def handle_fill(url: str, selector: str, value: str, wait_for: str | None = None) -> dict:
    """Navigate to a page and fill a form field."""
    if not selector:
        return {"content": "Error: selector is required for fill action", "isError": True}
    if value is None:
        return {"content": "Error: value is required for fill action", "isError": True}

    def fill_action(page):
        if wait_for:
            page.wait_for_selector(wait_for, timeout=10000)
        page.fill(selector, value)
        return page

    StealthyFetcher.fetch(
        url,
        headless=True,
        network_idle=True,
        page_action=fill_action,
    )
    return {"content": f'Filled "{selector}" with value "{value}"'}


def handle_evaluate(url: str, javascript: str, wait_for: str | None = None) -> dict:
    """Navigate to a page and evaluate JavaScript."""
    if not javascript:
        return {"content": "Error: javascript is required for evaluate action", "isError": True}

    js_result = None

    def eval_action(page):
        nonlocal js_result
        if wait_for:
            page.wait_for_selector(wait_for, timeout=10000)
        js_result = page.evaluate(javascript)
        return page

    StealthyFetcher.fetch(
        url,
        headless=True,
        network_idle=True,
        page_action=eval_action,
    )
    result_str = json.dumps(js_result, indent=2, default=str)
    return {"content": f"JavaScript result:\n{truncate(result_str, 10000)}"}


def main():
    try:
        raw = sys.stdin.read()
        cmd = json.loads(raw)
    except (json.JSONDecodeError, Exception) as e:
        print(json.dumps({"content": f"Invalid input: {e}", "isError": True}))
        sys.exit(1)

    url = cmd.get("url")
    action = cmd.get("action", "get_content")
    selector = cmd.get("selector")
    value = cmd.get("value")
    javascript = cmd.get("javascript")
    wait_for = cmd.get("wait_for")

    if not url:
        print(json.dumps({"content": "Error: url is required", "isError": True}))
        sys.exit(1)

    try:
        if action == "get_content":
            result = handle_get_content(url, wait_for)
        elif action == "click":
            result = handle_click(url, selector, wait_for)
        elif action == "fill":
            result = handle_fill(url, selector, value, wait_for)
        elif action == "evaluate":
            result = handle_evaluate(url, javascript, wait_for)
        else:
            result = {"content": f"Unknown action: {action}", "isError": True}
    except Exception as e:
        result = {"content": f"scrapling error: {e}", "isError": True}

    print(json.dumps(result))


if __name__ == "__main__":
    main()
