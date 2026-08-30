#!/usr/bin/env python3
"""Structural, leakage, syntax, and fixture checks for the template."""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "scenario" / "pesos-social-to-wordpress.template.json"
FIXTURES = ROOT / "examples" / "events"
EXPECTED_AGENTS = [
    "Agents::WebhookAgent",
    "Agents::JavaScriptAgent",
    "Agents::TriggerAgent",
    "Agents::PostAgent",
    "Agents::TriggerAgent",
    "Agents::PostAgent",
    "Agents::JavaScriptAgent",
    "Agents::PostAgent",
]


def load_renderer():
    spec = importlib.util.spec_from_file_location("renderer", ROOT / "tools" / "render.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def check_structure() -> dict:
    scenario = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    assert scenario["schema_version"] == 1
    assert [agent["type"] for agent in scenario["agents"]] == EXPECTED_AGENTS
    assert len({agent["guid"] for agent in scenario["agents"]}) == len(scenario["agents"])
    assert len(scenario["links"]) == 9
    for link in scenario["links"]:
        assert 0 <= link["source"] < len(scenario["agents"])
        assert 0 <= link["receiver"] < len(scenario["agents"])
        assert link["source"] != link["receiver"]

    text = TEMPLATE.read_text(encoding="utf-8")
    for placeholder in (
        "__WORDPRESS_BASE_URL__",
        "__WP_USERNAME_CREDENTIAL__",
        "__WP_APPLICATION_PASSWORD_CREDENTIAL__",
        "__WEBHOOK_SECRET__",
        "__ROUTING_TAG__",
        "__POST_STATUS__",
    ):
        assert placeholder in text
    return scenario


def check_render() -> dict:
    renderer = load_renderer()
    rendered = renderer.render_scenario(
        {
            "wordpress_base_url": "https://archive.example",
            "wordpress_username_credential": "pesos_wp_username",
            "wordpress_application_password_credential": "pesos_wp_application_password",
            "webhook_secret": "0123456789abcdefghijklmnopqrstuvwxyzAB",
            "routing_tag": "socialposts",
            "post_status": "draft",
        }
    )
    assert not re.search(r"__[A-Z0-9_]+__", rendered)
    scenario = json.loads(rendered)
    assert scenario["agents"][0]["options"]["secret"].startswith("012345")
    assert scenario["agents"][3]["options"]["post_url"] == "https://archive.example/wp-json/wp/v2/media"
    assert 'var PX_POST_STATUS = "draft"' in scenario["agents"][1]["options"]["code"]
    return scenario


def check_leaks() -> None:
    forbidden = [
        "mario" + "breskic",
        "socialposts" + "_huginn",
        "socialposts" + "_username",
        "111698" + "847188213781",
        "socialposts_" + "bluesky(1).json",
        "socialposts_" + "instagram.json",
        "socialposts_" + "mastodon(1).json",
        "socialposts_" + "threads(1).json",
        "socialposts_" + "tumblr(1).json",
        "socialposts_" + "twitter(1).json",
    ]
    files = [path for path in ROOT.rglob("*") if path.is_file() and "build" not in path.parts]
    corpus = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in files
        if ".git" not in path.parts
    ).lower()
    for value in forbidden:
        assert value.lower() not in corpus, f"forbidden source value found: {value}"


def check_fixtures() -> list[dict]:
    fixtures = []
    schema = json.loads((ROOT / "docs" / "EVENT.schema.json").read_text(encoding="utf-8"))
    assert schema["required"] == ["source", "source_url", "created_at", "trigger_tag"]
    paths = sorted(FIXTURES.glob("*.json"))
    assert [path.stem for path in paths] == ["bluesky", "instagram", "mastodon", "threads", "tumblr", "twitter"]
    for path in paths:
        event = json.loads(path.read_text(encoding="utf-8"))
        for field in ("source", "source_url", "created_at", "trigger_tag"):
            assert event.get(field), f"{path.name}: missing {field}"
        assert event["source_url"].startswith("https://")
        assert event["trigger_tag"] == "socialposts"
        fixtures.append(event)
    return fixtures


def run_node(source: str) -> dict | list:
    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as handle:
        handle.write(source)
        path = Path(handle.name)
    try:
        result = subprocess.run(["node", str(path)], check=True, capture_output=True, text=True)
        return json.loads(result.stdout)
    finally:
        path.unlink(missing_ok=True)


def check_javascript(fixtures: list[dict]) -> None:
    if not shutil.which("node"):
        print("node not found; JavaScript runtime checks skipped")
        return

    for source_path in (ROOT / "src" / "normalize.js", ROOT / "src" / "collect.js"):
        subprocess.run(["node", "--check", str(source_path)], check=True, capture_output=True, text=True)

    normalize = (ROOT / "src" / "normalize.js").read_text(encoding="utf-8")
    normalize = normalize.replace("__ROUTING_TAG__", "socialposts").replace("__POST_STATUS__", "draft")
    collect = (ROOT / "src" / "collect.js").read_text(encoding="utf-8")

    for fixture in fixtures:
        harness = (
            "var output = []; var memory = {};\n"
            "var Agent = {\n"
            f"  incomingEvents: function() {{ return [{{payload: {json.dumps(fixture, ensure_ascii=False)}}}]; }},\n"
            "  memory: function(key, value) { if (arguments.length === 2) { memory[key] = value; } return memory[key]; },\n"
            "  createEvent: function(value) { output.push(value); },\n"
            "  error: function() {}\n"
            "};\n" + normalize + "\nAgent.receive();\nconsole.log(JSON.stringify(output));\n"
        )
        events = run_node(harness)
        assert isinstance(events, list)
        assert not [event for event in events if event.get("event_type") == "job_failed"], fixture["source"]
        starts = [event for event in events if event.get("event_type") == "job_start"]
        assert len(starts) == 1, fixture["source"]
        job = starts[0]["job_data"]
        assert job["source"] == fixture["source"]
        assert job["post_status"] == "draft"
        media_requests = [event for event in events if event.get("event_type") == "media_request"]
        term_requests = [event for event in events if event.get("event_type") == "term_request"]
        assert len(media_requests) == job["media_count"]
        assert len(term_requests) == job["term_count"]

        responses = [starts[0]]
        for index, request in enumerate(media_requests):
            response = dict(request)
            response.update(
                {
                    "status": 201,
                    "body": {
                        "id": 1000 + index,
                        "source_url": f"https://archive.example/media/{1000 + index}",
                        "alt_text": request.get("media_alt", ""),
                    },
                }
            )
            responses.append(response)
        for index, request in enumerate(term_requests):
            response = dict(request)
            response.update({"status": 201, "body": {"id": 2000 + index}})
            responses.append(response)

        collector_harness = (
            "var output = []; var memory = {};\n"
            "var Agent = {\n"
            f"  incomingEvents: function() {{ return {json.dumps([{'payload': item} for item in responses], ensure_ascii=False)}; }},\n"
            "  memory: function(key, value) { if (arguments.length === 2) { memory[key] = value; } return memory[key]; },\n"
            "  createEvent: function(value) { output.push(value); },\n"
            "  error: function() {}\n"
            "};\n" + collect + "\nAgent.receive();\nconsole.log(JSON.stringify(output));\n"
        )
        posts = run_node(collector_harness)
        assert isinstance(posts, list) and len(posts) == 1, fixture["source"]
        assert posts[0]["status"] == "draft"
        assert fixture["source_url"] in posts[0]["content"]
        assert "#socialposts" not in posts[0]["content"].lower()


def main() -> None:
    check_structure()
    check_render()
    check_leaks()
    fixtures = check_fixtures()
    check_javascript(fixtures)
    print("validated: scenario graph, placeholders, safe defaults, six fixtures, and response join")


if __name__ == "__main__":
    main()
