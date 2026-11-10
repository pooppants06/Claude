"""Lagrer siste kjente status mellom kjøringer (state.json) og en endringslogg (history.jsonl)."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from datetime import datetime
from pathlib import Path


log = logging.getLogger("ps5monitor")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class State:
    VERSION = 1

    def __init__(self, path: Path, history_path: Path | None = None):
        self.path = path
        self.history_path = history_path
        self.items: dict[str, dict] = {}
        self.stores: dict[str, dict] = {}
        self.discovered: dict[str, list[str]] = {}
        self.meta: dict = {}
        self.first_run = True
        self._dirty = False
        self._last_save = 0.0
        self.load()

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # Ødelagt fil: ta vare på den og start på nytt i stedet for å krasje.
            try:
                self.path.replace(self.path.with_suffix(".json.corrupt"))
            except OSError:
                pass
            return
        self.items = data.get("items", {})
        self.stores = data.get("stores", {})
        self.discovered = data.get("discovered", {})
        self.meta = data.get("meta", {})
        self.first_run = not self.items

    def item(self, key: str) -> dict | None:
        return self.items.get(key)

    def touch(self) -> None:
        self._dirty = True

    def save(self, force: bool = False) -> None:
        if not self._dirty and not force:
            return
        if not force and time.monotonic() - self._last_save < 5:
            return
        payload = {
            "version": self.VERSION,
            "saved": now_iso(),
            "meta": self.meta,
            "stores": self.stores,
            "discovered": self.discovered,
            "items": self.items,
        }
        self._last_save = time.monotonic()
        tmp = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".state-", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)
        except OSError as exc:
            # F.eks. antivirus/skysynk som holder filen et øyeblikk. Prøves igjen ved neste
            # lagring; overvåkingen skal ikke stoppe av dette.
            log.warning("Klarte ikke å lagre %s (%s) – prøver igjen senere.", self.path.name, exc)
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
            return
        self._dirty = False

    def log_event(self, record: dict) -> None:
        if not self.history_path:
            return
        try:
            with open(self.history_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"time": now_iso(), **record}, ensure_ascii=False) + "\n")
        except OSError:
            pass
