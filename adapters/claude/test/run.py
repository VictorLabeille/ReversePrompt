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
READ_VARS = ("CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PID", "TERM_PROGRAM", "REVERSE_PROMPT_TEST_STDIN_TTY")


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
sys.exit(1 if failures else 0)
