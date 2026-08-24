from __future__ import annotations

import argparse
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

import task as task_cli  # noqa: E402
from common import task_context, task_lineage, task_store  # noqa: E402


class TaskLineageSchemaTests(unittest.TestCase):
    def test_empty_lineage_is_valid(self) -> None:
        lineage = task_lineage.new_lineage()

        self.assertEqual(lineage["schemaVersion"], 1)
        self.assertEqual(task_lineage.validate_lineage(lineage), [])
        self.assertTrue(all(lineage[stage] == [] for stage in task_lineage.LINEAGE_STAGES))

    def test_lineage_rejects_unknown_fields_and_duplicate_entries(self) -> None:
        lineage = task_lineage.new_lineage()
        entry = {"kind": "github_issue", "ref": "https://github.com/example/repo/issues/1"}
        lineage["request"] = [entry, dict(entry)]
        lineage["unexpected"] = []

        errors = task_lineage.validate_lineage(lineage)

        self.assertTrue(any("unknown keys" in error for error in errors))
        self.assertTrue(any("duplicates an earlier entry" in error for error in errors))

    def test_legacy_task_without_lineage_remains_valid(self) -> None:
        self.assertEqual(
            task_lineage.validate_task_lineage({"title": "legacy", "meta": {"owner": "team"}}),
            [],
        )

    def test_lineage_rejects_prose_absolute_paths_and_traversal(self) -> None:
        for reference in ("copied prose", "/tmp/evidence", "../secret"):
            lineage = task_lineage.new_lineage()
            lineage["evidence"] = [{"kind": "artifact", "ref": reference}]
            self.assertTrue(task_lineage.validate_lineage(lineage), reference)


class TaskLineageCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo_root = Path(self.temp_dir.name)
        self.tasks_dir = self.repo_root / ".trellis" / "tasks"
        self.task_dir = self.tasks_dir / "08-24-demo"
        self.task_dir.mkdir(parents=True)
        self.task_json = self.task_dir / "task.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def _write_task(self, data: dict | None = None) -> dict:
        task_data = data or {
            "id": "demo",
            "title": "Demo",
            "meta": {"owner": "team"},
            "custom": {"preserved": True},
        }
        self.task_json.write_text(json.dumps(task_data), encoding="utf-8")
        return task_data

    def _args(self, **overrides: object) -> argparse.Namespace:
        values: dict[str, object] = {
            "dir": "08-24-demo",
            "stage": "request",
            "kind": "github_issue",
            "ref": "https://github.com/example/repo/issues/1",
            "json": False,
        }
        values.update(overrides)
        return argparse.Namespace(**values)

    def test_add_lineage_initializes_legacy_task_and_preserves_unknown_fields(self) -> None:
        original = self._write_task()

        with patch.object(task_lineage, "get_repo_root", return_value=self.repo_root):
            result = task_lineage.cmd_add_lineage(self._args())

        self.assertEqual(result, 0)
        updated = json.loads(self.task_json.read_text(encoding="utf-8"))
        self.assertEqual(updated["custom"], original["custom"])
        self.assertEqual(updated["meta"]["owner"], "team")
        self.assertEqual(
            updated["meta"]["lineage"]["request"],
            [{"kind": "github_issue", "ref": "https://github.com/example/repo/issues/1"}],
        )

    def test_duplicate_add_is_idempotent(self) -> None:
        self._write_task()

        with patch.object(task_lineage, "get_repo_root", return_value=self.repo_root):
            self.assertEqual(task_lineage.cmd_add_lineage(self._args()), 0)
            self.assertEqual(task_lineage.cmd_add_lineage(self._args()), 0)

        updated = json.loads(self.task_json.read_text(encoding="utf-8"))
        self.assertEqual(len(updated["meta"]["lineage"]["request"]), 1)

    def test_invalid_existing_lineage_fails_without_rewriting_task(self) -> None:
        self._write_task({"id": "demo", "meta": {"lineage": "legacy-string"}})
        before = self.task_json.read_bytes()

        with patch.object(task_lineage, "get_repo_root", return_value=self.repo_root):
            with redirect_stderr(StringIO()):
                result = task_lineage.cmd_add_lineage(self._args())

        self.assertEqual(result, 1)
        self.assertEqual(self.task_json.read_bytes(), before)

    def test_write_failure_returns_error_without_rewriting_task(self) -> None:
        self._write_task()
        before = self.task_json.read_bytes()

        with (
            patch.object(task_lineage, "get_repo_root", return_value=self.repo_root),
            patch.object(task_lineage, "write_json", return_value=False),
            redirect_stderr(StringIO()),
        ):
            result = task_lineage.cmd_add_lineage(self._args())

        self.assertEqual(result, 1)
        self.assertEqual(self.task_json.read_bytes(), before)

    def test_lineage_commands_reject_paths_outside_active_tasks(self) -> None:
        self._write_task()
        outside_dir = self.repo_root / "outside"
        outside_dir.mkdir()
        outside_json = outside_dir / "task.json"
        outside_json.write_text('{"id":"outside"}', encoding="utf-8")

        with patch.object(task_lineage, "get_repo_root", return_value=self.repo_root):
            with redirect_stderr(StringIO()):
                result = task_lineage.cmd_add_lineage(
                    self._args(dir=str(outside_dir))
                )

        self.assertEqual(result, 1)
        self.assertEqual(outside_json.read_text(encoding="utf-8"), '{"id":"outside"}')

    def test_lineage_commands_reject_symlinked_and_archived_tasks(self) -> None:
        self._write_task()
        outside_dir = self.repo_root / "outside"
        outside_dir.mkdir()
        (outside_dir / "task.json").write_text('{"id":"outside"}', encoding="utf-8")
        (self.tasks_dir / "linked-task").symlink_to(outside_dir, target_is_directory=True)
        archived_dir = self.tasks_dir / "archive" / "2026-08" / "08-24-archived"
        archived_dir.mkdir(parents=True)
        (archived_dir / "task.json").write_text('{"id":"archived"}', encoding="utf-8")

        with patch.object(task_lineage, "get_repo_root", return_value=self.repo_root):
            with redirect_stderr(StringIO()):
                linked_result = task_lineage.cmd_add_lineage(self._args(dir="linked-task"))
                archived_result = task_lineage.cmd_add_lineage(
                    self._args(dir=str(archived_dir))
                )

        self.assertEqual(linked_result, 1)
        self.assertEqual(archived_result, 1)

    def test_remove_lineage_requires_an_exact_entry(self) -> None:
        self._write_task()

        with patch.object(task_lineage, "get_repo_root", return_value=self.repo_root):
            self.assertEqual(task_lineage.cmd_add_lineage(self._args()), 0)
            self.assertEqual(task_lineage.cmd_remove_lineage(self._args()), 0)
            with redirect_stderr(StringIO()):
                self.assertEqual(task_lineage.cmd_remove_lineage(self._args()), 1)

        updated = json.loads(self.task_json.read_text(encoding="utf-8"))
        self.assertEqual(updated["meta"]["lineage"]["request"], [])

    def test_list_lineage_does_not_write_to_legacy_task(self) -> None:
        self._write_task()
        before = self.task_json.read_bytes()

        with patch.object(task_lineage, "get_repo_root", return_value=self.repo_root):
            with redirect_stdout(StringIO()) as output:
                result = task_lineage.cmd_list_lineage(self._args(json=True))

        self.assertEqual(result, 0)
        self.assertFalse(json.loads(output.getvalue())["present"])
        self.assertEqual(self.task_json.read_bytes(), before)

    def test_task_validate_fails_for_malformed_lineage(self) -> None:
        self._write_task({"id": "demo", "meta": {"lineage": {"schemaVersion": 1}}})

        with patch.object(task_context, "get_repo_root", return_value=self.repo_root):
            with redirect_stdout(StringIO()):
                result = task_context.cmd_validate(argparse.Namespace(dir="08-24-demo"))

        self.assertEqual(result, 1)


class TaskCreationLineageTests(unittest.TestCase):
    def test_create_initializes_structured_lineage_and_reserves_meta_key(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            tasks_dir = repo_root / ".trellis" / "tasks"
            args = argparse.Namespace(
                title="Demo task",
                slug="demo",
                assignee="developer",
                priority="P2",
                description="Track delivery lineage",
                parent=None,
                package=None,
                base_branch=None,
                meta=["owner=team"],
                no_start=True,
            )

            with (
                patch.object(task_store, "get_repo_root", return_value=repo_root),
                patch.object(task_store, "get_tasks_dir", return_value=tasks_dir),
                patch.object(task_store, "get_developer", return_value="developer"),
                patch.object(task_store, "is_monorepo", return_value=False),
                patch.object(task_store, "generate_task_date_prefix", return_value="08-24"),
                patch.object(task_store, "run_git", return_value=(0, "codex/test\n", "")),
                patch.object(task_store, "resolve_default_branch", return_value="main"),
                patch.object(task_store, "_has_subagent_platform", return_value=False),
                patch.object(task_store, "run_task_hooks"),
                redirect_stderr(StringIO()),
            ):
                result = task_store.cmd_create(args)

            self.assertEqual(result, 0)
            data = json.loads(
                (tasks_dir / "08-24-demo" / "task.json").read_text(encoding="utf-8")
            )
            self.assertEqual(data["meta"]["owner"], "team")
            self.assertEqual(
                task_lineage.validate_lineage(data["meta"]["lineage"]),
                [],
            )

            reserved_args = argparse.Namespace(**{**vars(args), "slug": "reserved", "meta": ["lineage=value"]})
            with (
                patch.object(task_store, "get_repo_root", return_value=repo_root),
                redirect_stderr(StringIO()),
            ):
                self.assertEqual(task_store.cmd_create(reserved_args), 1)
            self.assertFalse((tasks_dir / "08-24-reserved").exists())

    def test_set_meta_cannot_overwrite_structured_lineage(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            task_dir = repo_root / ".trellis" / "tasks" / "08-24-demo"
            task_dir.mkdir(parents=True)
            task_json = task_dir / "task.json"
            task_json.write_text(json.dumps({"id": "demo", "meta": {}}), encoding="utf-8")
            before = task_json.read_bytes()

            with (
                patch.object(task_store, "get_repo_root", return_value=repo_root),
                redirect_stderr(StringIO()),
            ):
                result = task_store.cmd_set_meta(
                    argparse.Namespace(dir="08-24-demo", key="lineage", value="overwrite")
                )

            self.assertEqual(result, 1)
            self.assertEqual(task_json.read_bytes(), before)


class TaskLineageParserTests(unittest.TestCase):
    def test_cli_parser_dispatches_add_lineage_arguments(self) -> None:
        argv = [
            "task.py",
            "add-lineage",
            "08-24-demo",
            "request",
            "github_issue",
            "https://github.com/example/repo/issues/1",
        ]
        with (
            patch.object(sys, "argv", argv),
            patch.object(task_cli, "cmd_add_lineage", return_value=0) as handler,
        ):
            self.assertEqual(task_cli.main(), 0)

        args = handler.call_args.args[0]
        self.assertEqual(args.dir, "08-24-demo")
        self.assertEqual(args.stage, "request")
        self.assertEqual(args.kind, "github_issue")


if __name__ == "__main__":
    unittest.main()
