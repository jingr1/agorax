"""Canonical mission artifact paths under memory/swarm/missions/<missionId>/."""

from __future__ import annotations

import os
import re

_LEGACY_OUTPUT_RE = re.compile(r"(^|[\s`'\"(])output/([a-z0-9_-]+)/", re.IGNORECASE)


def mission_root(memory_root: str, mission_id: str) -> str:
    return os.path.join(memory_root, "memory", "swarm", "missions", mission_id.strip())


def mission_worker_dir(memory_root: str, mission_id: str, worker_id: str) -> str:
    return os.path.join(mission_root(memory_root, mission_id), worker_id.strip())


def artifact_path_instructions(
    mission_id: str,
    worker_id: str,
    *,
    memory_root: str | None = None,
) -> str:
    root = memory_root or os.path.expanduser("~/hermes-workspace")
    worker_dir = mission_worker_dir(root, mission_id, worker_id)
    manifest = os.path.join(mission_root(root, mission_id), "manifest.json")
    return (
        "## Mission artifact directory (required)\n"
        f"Write all deliverables for this assignment under:\n{worker_dir}/\n"
        f"Mission manifest (update when you add files):\n{manifest}\n"
        "Do not write new files under `output/` — that tree is legacy and ignored by the platform.\n"
        "FILES_CHANGED must list absolute paths under the mission directory above."
    )


def rewrite_legacy_output_paths(text: str, mission_id: str) -> str:
    if not mission_id.strip():
        return text

    def _replace(match: re.Match[str]) -> str:
        prefix, role = match.group(1), match.group(2)
        return f"{prefix}memory/swarm/missions/{mission_id}/{role}/"

    return _LEGACY_OUTPUT_RE.sub(_replace, text)
