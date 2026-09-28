#!/usr/bin/env python3
# Passe les cas de cases.json dans les deux traductions : notify.py (WSL) et notify.ps1
# (Windows, via powershell.exe si disponible). Usage : python3 adapters/claude/test/run.py
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ADAPTER = os.path.dirname(HERE)
cases = json.load(open(os.path.join(HERE, "cases.json"), encoding="utf-8"))

# Variables lues par les traductions : retirées de l'environnement réel avant chaque cas.
READ_VARS = (
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE",
    "CLAUDE_PID",
    "TERM_PROGRAM",
    "REVERSE_PROMPT_TEST_STDIN_TTY",
)


def env_for(case):
    env = {k: v for k, v in os.environ.items() if k not in READ_VARS}
    env.update(case["env"])
    return env


def run_python(case):
    out = subprocess.run(
        [sys.executable, os.path.join(ADAPTER, "notify.py"), "--print"],
        input=json.dumps(case["hook"]).encode(), env=env_for(case), capture_output=True, check=True,
    ).stdout
    return json.loads(out)


def run_powershell(case):
    # Les variables passent à powershell.exe par WSLENV.
    env = env_for(case)
    env["WSLENV"] = ":".join(k for k in READ_VARS if k in case["env"])
    script = subprocess.run(["wslpath", "-w", os.path.join(ADAPTER, "notify.ps1")], capture_output=True, text=True).stdout.strip()
    out = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Print"],
        input=json.dumps(case["hook"]).encode(), env=env, capture_output=True, check=True, cwd="/mnt/c",
    ).stdout
    return json.loads(out.decode("utf-8", "replace").strip() or "null")


failures = 0
runners = [("notify.py", run_python, "linux")]
if shutil.which("powershell.exe"):
    runners.append(("notify.ps1", run_powershell, "windows"))
for label, runner, platform in runners:
    for case in cases:
        if case.get("only") not in (None, platform):
            continue
        got = runner(case)
        if got != case["expect"]:
            failures += 1
            print(f"ÉCHEC {label} — {case['name']}\n  attendu {case['expect']}\n  obtenu  {got}")
    print(f"{label} : {'ok' if not failures else 'échecs'}")

# Mode --title (notify.py seul : côté Windows, aucun hook n'écrit le titre).
TITLE_ENV = {"CLAUDE_CODE_ENTRYPOINT": "cli", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1"}
title_cases = [
    ("SessionStart", TITLE_ENV, "/home/v/mon-projet/", {"terminalSequence": "\x1b]2;mon-projet · 5f0c2d\x07"}),
    ("UserPromptSubmit", TITLE_ENV, "/", {"terminalSequence": "\x1b]2;claude · 5f0c2d\x07"}),
    ("Stop", TITLE_ENV, "/home/v/p", None),
    ("SessionStart", {"CLAUDE_CODE_ENTRYPOINT": "cli"}, "/home/v/p", None),
    ("SessionStart", {**TITLE_ENV, "TERM_PROGRAM": "vscode"}, "/home/v/p", None),
    ("SessionStart", {**TITLE_ENV, "CLAUDE_CODE_ENTRYPOINT": "claude-desktop"}, "/home/v/p", None),
]
for event, env, cwd, expect in title_cases:
    hook = {"hook_event_name": event, "session_id": "5F0C2D1E-aaaa", "cwd": cwd}
    out = subprocess.run(
        [sys.executable, os.path.join(ADAPTER, "notify.py"), "--title"],
        input=json.dumps(hook).encode(), env=env_for({"env": env}), capture_output=True, check=True,
    ).stdout
    got = json.loads(out) if out.strip() else None
    if got != expect:
        failures += 1
        print(f"ÉCHEC notify.py --title — {event} {env}\n  attendu {expect}\n  obtenu  {got}")
print(f"notify.py --title : {'ok' if not failures else 'échecs'}")
sys.exit(1 if failures else 0)
