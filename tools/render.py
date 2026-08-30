#!/usr/bin/env python3
"""Render a private, importable Scenario without editing the committed template."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "scenario" / "pesos-social-to-wordpress.template.json"
DEFAULT_OUTPUT = ROOT / "build" / "pesos-social-to-wordpress.json"
PLACEHOLDERS = {
    "wordpress_base_url": "__WORDPRESS_BASE_URL__",
    "wordpress_username_credential": "__WP_USERNAME_CREDENTIAL__",
    "wordpress_application_password_credential": "__WP_APPLICATION_PASSWORD_CREDENTIAL__",
    "webhook_secret": "__WEBHOOK_SECRET__",
    "routing_tag": "__ROUTING_TAG__",
    "post_status": "__POST_STATUS__",
}


def validate_config(config: dict, allow_publish: bool = False) -> dict[str, str]:
    missing = [key for key in PLACEHOLDERS if not isinstance(config.get(key), str) or not config[key].strip()]
    if missing:
        raise ValueError("missing configuration: " + ", ".join(missing))

    values = {key: config[key].strip() for key in PLACEHOLDERS}
    values["wordpress_base_url"] = values["wordpress_base_url"].rstrip("/")
    parsed = urlsplit(values["wordpress_base_url"])
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path:
        raise ValueError("wordpress_base_url must be an HTTPS origin without a path or user information")

    credential = re.compile(r"^[A-Za-z][A-Za-z0-9_]{2,63}$")
    for key in ("wordpress_username_credential", "wordpress_application_password_credential"):
        if not credential.fullmatch(values[key]):
            raise ValueError(f"{key} must be a plain Huginn credential name")

    if not re.fullmatch(r"[A-Za-z0-9_]{2,64}", values["routing_tag"]):
        raise ValueError("routing_tag may contain letters, numbers, and underscores")
    if values["post_status"] not in {"draft", "pending", "private", "publish"}:
        raise ValueError("post_status must be draft, pending, private, or publish")
    if values["post_status"] == "publish" and not allow_publish:
        raise ValueError("publishing requires --allow-publish; review drafts first")

    secret = values["webhook_secret"]
    if len(secret) < 32 or "replace" in secret.lower() or "example" in secret.lower():
        raise ValueError("webhook_secret must be a non-example value of at least 32 characters")
    if not re.fullmatch(r"[A-Za-z0-9._~-]+", secret):
        raise ValueError("webhook_secret must be URL-path safe")
    return values


def render_scenario(config: dict, allow_publish: bool = False) -> str:
    values = validate_config(config, allow_publish=allow_publish)
    rendered = TEMPLATE.read_text(encoding="utf-8")
    for key, placeholder in PLACEHOLDERS.items():
        rendered = rendered.replace(placeholder, values[key])
    unresolved = sorted(set(re.findall(r"__[A-Z0-9_]+__", rendered)))
    if unresolved:
        raise ValueError("unresolved placeholders: " + ", ".join(unresolved))
    json.loads(rendered)
    return rendered


def check_template() -> None:
    text = TEMPLATE.read_text(encoding="utf-8")
    json.loads(text)
    missing = [placeholder for placeholder in PLACEHOLDERS.values() if placeholder not in text]
    if missing:
        raise ValueError("template is missing: " + ", ".join(missing))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("config", nargs="?", type=Path, help="private JSON config")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--allow-publish", action="store_true")
    parser.add_argument("--check-template", action="store_true")
    args = parser.parse_args()

    if args.check_template:
        check_template()
        print("template placeholders are intact")
        return
    if not args.config:
        parser.error("config is required unless --check-template is used")

    config = json.loads(args.config.read_text(encoding="utf-8"))
    rendered = render_scenario(config, allow_publish=args.allow_publish)
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(rendered, encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
