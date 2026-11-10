#!/usr/bin/env bash
# PS5 Pro-vakten – oppstart for Linux/macOS.  Bruk: ./start.sh [once|status|test-notify|check URL]
set -euo pipefail
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
  echo "Trenger Python 3.11 eller nyere (fant ikke det som '$PY')." >&2
  exit 1
fi
if [ ! -x .venv/bin/python ]; then
  echo "Setter opp Python-miljø (bare første gang) …"
  "$PY" -m venv .venv
  .venv/bin/python -m pip install --quiet --disable-pip-version-check -r requirements.txt
fi
if [ ! -f config.toml ]; then
  cp config.example.toml config.toml
  echo "Opprettet config.toml – legg inn Discord-webhook eller Telegram-bot der og start på nytt."
  exit 0
fi
exec .venv/bin/python -m ps5monitor "$@"
