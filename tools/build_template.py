#!/usr/bin/env python3
"""Build the importable Huginn template from its readable JavaScript sources."""

from __future__ import annotations

import json
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCENARIO_PATH = ROOT / "scenario" / "pesos-social-to-wordpress.template.json"
NAMESPACE = uuid.UUID("fa781b77-5a73-4fcb-9ae4-7a2901fb2edf")


def guid(label: str) -> str:
    return str(uuid.uuid5(NAMESPACE, label))


def common_agent(agent_type: str, name: str, options: dict, *, webhook: bool = False) -> dict:
    agent = {
        "type": agent_type,
        "name": name,
        "disabled": False,
        "guid": guid(name),
        "options": options,
        "keep_events_for": 604800,
    }
    if not webhook:
        agent.update({"schedule": "never", "propagate_immediately": True})
    return agent


def post_agent(name: str, path: str, payload: dict, *, no_merge: str = "true", output_mode: str = "merge") -> dict:
    return common_agent(
        "Agents::PostAgent",
        name,
        {
            "post_url": "__WORDPRESS_BASE_URL__" + path,
            "expected_receive_period_in_days": "7",
            "content_type": "json",
            "method": "post",
            "headers": {},
            "payload": payload,
            "basic_auth": [
                "{% credential __WP_USERNAME_CREDENTIAL__ %}",
                "{% credential __WP_APPLICATION_PASSWORD_CREDENTIAL__ %}",
            ],
            "emit_events": "true",
            "parse_body": "true",
            "no_merge": no_merge,
            "output_mode": output_mode,
        },
    )


def trigger_agent(name: str, event_type: str) -> dict:
    return common_agent(
        "Agents::TriggerAgent",
        name,
        {
            "expected_receive_period_in_days": "7",
            "keep_event": "true",
            "rules": [{"type": "field==value", "value": event_type, "path": "event_type"}],
        },
    )


def javascript_agent(name: str, source_name: str) -> dict:
    code = (ROOT / "src" / source_name).read_text(encoding="utf-8")
    return common_agent(
        "Agents::JavaScriptAgent",
        name,
        {
            "language": "JavaScript",
            "expected_receive_period_in_days": "7",
            "expected_update_period_in_days": "2",
            "code": code,
        },
    )


def build() -> dict:
    agents = [
        common_agent(
            "Agents::WebhookAgent",
            "01 — Receive normalized PESOS Event [SET SECRET]",
            {
                "expected_receive_period_in_days": "7",
                "secret": "__WEBHOOK_SECRET__",
                "payload_path": ".",
                "event_headers": "",
                "event_headers_key": "headers",
                "verbs": "post",
                "response": "Event accepted",
            },
            webhook=True,
        ),
        javascript_agent("02 — Normalize, validate, and fan out", "normalize.js"),
        trigger_agent("03 — Route media requests", "media_request"),
        post_agent(
            "04 — Sideload media into WordPress [SET CREDENTIALS]",
            "/wp-json/wp/v2/media",
            {
                "url": "{{media_url}}",
                "alt_text": "{{media_alt}}",
                "title": "{{media_title}}",
                "generate_sub_sizes": True,
            },
        ),
        trigger_agent("05 — Route taxonomy requests", "term_request"),
        post_agent(
            "06 — Create or find WordPress term [SET CREDENTIALS]",
            "/wp-json/wp/v2/{{term_endpoint}}",
            {"name": "{{term_name}}"},
        ),
        javascript_agent("07 — Join responses and build Gutenberg", "collect.js"),
        post_agent(
            "08 — Create WordPress draft [SET CREDENTIALS]",
            "/wp-json/wp/v2/posts",
            {},
            no_merge="false",
            output_mode="clean",
        ),
    ]

    # Indices are part of Huginn's export format, so the topology is explicit.
    links = [
        {"source": 0, "receiver": 1},
        {"source": 1, "receiver": 2},
        {"source": 1, "receiver": 4},
        {"source": 1, "receiver": 6},
        {"source": 2, "receiver": 3},
        {"source": 3, "receiver": 6},
        {"source": 4, "receiver": 5},
        {"source": 5, "receiver": 6},
        {"source": 6, "receiver": 7},
    ]

    return {
        "schema_version": 1,
        "name": "pesos_social_to_wordpress_template",
        "description": (
            "Platform-neutral PESOS archive core: validate one normalized webhook Event, "
            "sideload public HTTPS media, create source taxonomy, build Gutenberg, and save "
            "a WordPress draft. Render placeholders before importing."
        ),
        "source_url": False,
        "guid": guid("scenario"),
        "tag_fg_color": "#ffffff",
        "tag_bg_color": "#3858e9",
        "icon": "archive",
        "exported_at": "2026-08-30T00:00:00Z",
        "agents": agents,
        "links": links,
        "control_links": [],
    }


def main() -> None:
    SCENARIO_PATH.parent.mkdir(parents=True, exist_ok=True)
    SCENARIO_PATH.write_text(
        json.dumps(build(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(SCENARIO_PATH.relative_to(ROOT))


if __name__ == "__main__":
    main()
