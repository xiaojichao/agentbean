#!/usr/bin/env python3
"""Machine-readable SDLC lineage stored in ``task.json.meta.lineage``."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from .io import read_json, write_json
from .log import Colors, colored
from .paths import FILE_TASK_JSON, get_repo_root
from .task_utils import is_within_tasks_dir, resolve_task_dir


LINEAGE_SCHEMA_VERSION = 1
LINEAGE_META_KEY = "lineage"
LINEAGE_STAGES: tuple[str, ...] = (
    "request",
    "context",
    "decisions",
    "design",
    "implementation",
    "delivery",
    "evidence",
)

_ENTRY_KEYS = {"kind", "ref"}
_KIND_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_MAX_REF_LENGTH = 2048


def new_lineage() -> dict:
    """Return a fresh, empty lineage document."""
    return {
        "schemaVersion": LINEAGE_SCHEMA_VERSION,
        **{stage: [] for stage in LINEAGE_STAGES},
    }


def _reference_error(reference: object) -> str | None:
    if not isinstance(reference, str) or not reference:
        return "must be a non-empty string"
    if reference != reference.strip() or any(char.isspace() for char in reference):
        return "must not contain leading, trailing, or embedded whitespace"
    if len(reference) > _MAX_REF_LENGTH:
        return f"must be at most {_MAX_REF_LENGTH} characters"
    if reference.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", reference):
        return "must not be a local absolute path"
    if reference.lower().startswith("file://"):
        return "must not use a local file URL"

    # URLs and opaque IDs may contain path-like punctuation. For repository
    # paths, reject traversal so the index cannot point outside the checkout.
    if not re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", reference):
        path_part = reference.split("#", 1)[0].replace("\\", "/")
        if ".." in path_part.split("/"):
            return "must not contain repository path traversal"
    return None


def validate_lineage(lineage: object) -> list[str]:
    """Validate a lineage document and return human-readable errors."""
    if not isinstance(lineage, dict):
        return ["meta.lineage must be an object"]

    errors: list[str] = []
    expected_keys = {"schemaVersion", *LINEAGE_STAGES}
    actual_keys = set(lineage)
    missing_keys = sorted(expected_keys - actual_keys)
    unknown_keys = sorted(actual_keys - expected_keys)
    if missing_keys:
        errors.append(f"meta.lineage is missing keys: {', '.join(missing_keys)}")
    if unknown_keys:
        errors.append(f"meta.lineage has unknown keys: {', '.join(unknown_keys)}")

    if lineage.get("schemaVersion") != LINEAGE_SCHEMA_VERSION:
        errors.append(
            f"meta.lineage.schemaVersion must be {LINEAGE_SCHEMA_VERSION}"
        )

    for stage in LINEAGE_STAGES:
        entries = lineage.get(stage)
        if not isinstance(entries, list):
            errors.append(f"meta.lineage.{stage} must be an array")
            continue

        seen: set[tuple[str, str]] = set()
        for index, entry in enumerate(entries):
            location = f"meta.lineage.{stage}[{index}]"
            if not isinstance(entry, dict):
                errors.append(f"{location} must be an object")
                continue
            if set(entry) != _ENTRY_KEYS:
                errors.append(f"{location} must contain exactly kind and ref")
                continue

            kind = entry.get("kind")
            reference = entry.get("ref")
            if not isinstance(kind, str) or not _KIND_RE.fullmatch(kind):
                errors.append(
                    f"{location}.kind must match {_KIND_RE.pattern}"
                )
            reference_error = _reference_error(reference)
            if reference_error:
                errors.append(f"{location}.ref {reference_error}")

            if isinstance(kind, str) and isinstance(reference, str):
                identity = (kind, reference)
                if identity in seen:
                    errors.append(f"{location} duplicates an earlier entry")
                seen.add(identity)

    return errors


def validate_task_lineage(task_data: object) -> list[str]:
    """Validate optional lineage within a task document.

    Legacy tasks without ``meta.lineage`` remain valid. Once the field exists,
    it must conform exactly to the versioned schema.
    """
    if not isinstance(task_data, dict):
        return ["task.json must contain a JSON object"]

    meta = task_data.get("meta")
    if meta is None:
        return []
    if not isinstance(meta, dict):
        return ["task.json.meta must be an object"]
    if LINEAGE_META_KEY not in meta:
        return []
    return validate_lineage(meta[LINEAGE_META_KEY])


def ensure_task_lineage(task_data: dict) -> dict:
    """Return the valid lineage document, creating it when absent."""
    meta = task_data.get("meta")
    if meta is None:
        meta = {}
        task_data["meta"] = meta
    if not isinstance(meta, dict):
        raise ValueError("task.json.meta must be an object")

    lineage = meta.get(LINEAGE_META_KEY)
    if lineage is None:
        lineage = new_lineage()
        meta[LINEAGE_META_KEY] = lineage

    errors = validate_lineage(lineage)
    if errors:
        raise ValueError("; ".join(errors))
    return lineage


def _load_task_data(task_input: str) -> tuple[Path, dict] | None:
    repo_root = get_repo_root()
    target_dir = resolve_task_dir(task_input, repo_root)
    if not is_within_tasks_dir(target_dir, repo_root):
        print(
            colored(f"Error: not an active Trellis task directory: {target_dir}", Colors.RED),
            file=sys.stderr,
        )
        return None

    task_json = target_dir / FILE_TASK_JSON
    data = read_json(task_json)
    if not isinstance(data, dict) or not data:
        print(
            colored(f"Error: task.json is missing, unreadable, or not an object: {task_json}", Colors.RED),
            file=sys.stderr,
        )
        return None
    return task_json, data


def _validate_entry_args(stage: str, kind: str, reference: str) -> str | None:
    if stage not in LINEAGE_STAGES:
        return f"unknown lineage stage: {stage}"
    if not _KIND_RE.fullmatch(kind):
        return f"kind must match {_KIND_RE.pattern}"
    reference_error = _reference_error(reference)
    if reference_error:
        return f"ref {reference_error}"
    return None


def cmd_add_lineage(args: argparse.Namespace) -> int:
    """Append one typed reference to a task's lineage."""
    error = _validate_entry_args(args.stage, args.kind, args.ref)
    if error:
        print(colored(f"Error: {error}", Colors.RED), file=sys.stderr)
        return 1

    loaded = _load_task_data(args.dir)
    if loaded is None:
        return 1
    task_json, data = loaded

    try:
        lineage = ensure_task_lineage(data)
    except ValueError as exc:
        print(colored(f"Error: {exc}", Colors.RED), file=sys.stderr)
        return 1

    entry = {"kind": args.kind, "ref": args.ref}
    entries = lineage[args.stage]
    if entry in entries:
        print(colored("Lineage entry already exists", Colors.YELLOW))
        return 0
    entries.append(entry)

    if not write_json(task_json, data):
        print(colored(f"Error: failed to write {task_json}", Colors.RED), file=sys.stderr)
        return 1
    print(colored(f"✓ Added lineage: {args.stage} {args.kind} {args.ref}", Colors.GREEN))
    return 0


def cmd_remove_lineage(args: argparse.Namespace) -> int:
    """Remove one exact typed reference from a task's lineage."""
    error = _validate_entry_args(args.stage, args.kind, args.ref)
    if error:
        print(colored(f"Error: {error}", Colors.RED), file=sys.stderr)
        return 1

    loaded = _load_task_data(args.dir)
    if loaded is None:
        return 1
    task_json, data = loaded

    try:
        lineage = ensure_task_lineage(data)
    except ValueError as exc:
        print(colored(f"Error: {exc}", Colors.RED), file=sys.stderr)
        return 1

    entry = {"kind": args.kind, "ref": args.ref}
    entries = lineage[args.stage]
    if entry not in entries:
        print(colored("Error: lineage entry not found", Colors.RED), file=sys.stderr)
        return 1
    entries.remove(entry)

    if not write_json(task_json, data):
        print(colored(f"Error: failed to write {task_json}", Colors.RED), file=sys.stderr)
        return 1
    print(colored(f"✓ Removed lineage: {args.stage} {args.kind} {args.ref}", Colors.GREEN))
    return 0


def cmd_list_lineage(args: argparse.Namespace) -> int:
    """Print the task lineage without mutating legacy tasks."""
    loaded = _load_task_data(args.dir)
    if loaded is None:
        return 1
    _, data = loaded

    errors = validate_task_lineage(data)
    if errors:
        for error in errors:
            print(colored(f"Error: {error}", Colors.RED), file=sys.stderr)
        return 1

    meta = data.get("meta")
    lineage = meta.get(LINEAGE_META_KEY) if isinstance(meta, dict) else None
    present = lineage is not None
    if lineage is None:
        lineage = new_lineage()

    if getattr(args, "json", False):
        print(json.dumps({"present": present, "lineage": lineage}, ensure_ascii=False))
        return 0

    print(colored("=== Task Lineage ===", Colors.BLUE))
    for stage in LINEAGE_STAGES:
        print(f"{stage}:")
        entries = lineage[stage]
        if not entries:
            print("  (none)")
            continue
        for entry in entries:
            print(f"  - {entry['kind']}: {entry['ref']}")
    return 0
