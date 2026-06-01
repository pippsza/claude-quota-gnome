# Claude Quota — GNOME Shell indicator

A top-bar indicator (like Vitals, but for Claude) that shows your Claude.ai
Pro/Max usage limits. Click it for a dropdown with the full picture; each row
has a switch that toggles whether that bucket is shown in the panel.

![panel](docs/panel.png)

## What it shows

- **Session (5h)** — the rolling 5-hour limit
- **Weekly (7d)** — overall 7-day limit
- **Opus (7d)** / **Sonnet (7d)** — per-model weekly buckets (off by default)
- **Extra usage** — paid overage credits (read-only, in the dropdown)

The panel label is colour-coded: amber past the *warn* threshold (default 80%),
red past *critical* (95%). If a fetch fails (expired token, no network) the last
good reading is kept and dimmed with a `⚠`, so it never blanks out.

## Data source

The extension does **not** talk to Anthropic directly — it runs a helper script
that prints quota JSON to stdout. By default that's
[`tg-claude-bot/tools/check_quota.py`](https://github.com/pippsza/tg-claude-bot),
which hits the undocumented `oauth/usage` endpoint and **auto-refreshes** the
OAuth token when it has expired (so the indicator stays reliable even when the
CLI hasn't run in a while).

Expected JSON shape:

```json
{
  "ok": true,
  "session_5h":   {"used_percent": 28.0, "resets_in": "1h 52m"},
  "weekly_total": {"used_percent": 3.0,  "resets_in": "2d 11h"},
  "weekly_opus":  null,
  "weekly_sonnet":{"used_percent": 1.0,  "resets_in": "2d 11h"},
  "extra_usage":  {"is_enabled": true, "monthly_limit": 4500, "used_credits": 174, "utilization": 3.8}
}
```

Point it at any script via **Settings → Data source**.

## Install

```bash
make install      # compile schema + copy into ~/.local/share/gnome-shell/extensions
# log out and back in   (Wayland can't hot-reload the shell)
make enable
```

For development, `make link` symlinks the repo instead of copying.

## Develop on Wayland

You can't reload the shell with `Alt+F2 → r` on Wayland. Either log out/in after
each change, or test in a nested shell:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

Tail logs with `make logs`.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Refresh interval | 120s | min 15s |
| Python path | venv python | runs the script |
| Script path | check_quota.py | must print the JSON above |
| Warn / Critical | 80 / 95 | panel colour thresholds |
| Show session/weekly/opus/sonnet | on/on/off/off | also toggled from the dropdown |
