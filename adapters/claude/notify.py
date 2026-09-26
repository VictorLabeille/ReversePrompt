#!/usr/bin/env python3
# Adaptateur Claude Code → ReversePrompt, côté Linux/WSL.
#
# Hook unique pour tous les événements : lit le JSON du hook sur stdin, le traduit vers le
# contrat v1 (docs/event-contract.md) et l'envoie à l'app par `curl.exe` détaché. Ne bloque
# jamais Claude Code et sort toujours en 0, app arrêtée ou non.
#
# Règles de traduction : docs/adapters/claude.md. La version Windows (notify.ps1) applique
# exactement les mêmes ; les deux passent les cas de test/cases.json.
#
#   notify.py            traduit et envoie (usage normal, depuis un hook)
#   notify.py --print    traduit et écrit l'événement sur stdout, sans rien envoyer (tests)

import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_INPUT = 1 << 20

NEEDS_INPUT_NOTIFICATIONS = {
    "permission_prompt",
    "elicitation_dialog",
    "elicitation_url_dialog",
    "agent_needs_input",
}
DESKTOP_ENTRYPOINTS = {"claude-desktop", "claude-desktop-3p"}


def claude_stdin_is_tty(env):
    # Surcharge pour les tests : le vrai processus Claude n'existe pas.
    forced = env.get("REVERSE_PROMPT_TEST_STDIN_TTY")
    if forced is not None:
        return forced == "1"
    pid = env.get("CLAUDE_PID")
    if not pid:
        return True
    try:
        return os.readlink(f"/proc/{pid}/fd/0").startswith("/dev/pts/")
    except OSError:
        return True


# Où vit la session : "terminal", "desktop", ou None (rien à ramener : pas de notification).
def surface(env):
    entrypoint = env.get("CLAUDE_CODE_ENTRYPOINT", "")
    if entrypoint == "cli":
        return "terminal"
    if entrypoint in DESKTOP_ENTRYPOINTS:
        return "desktop"
    # Session Desktop dans WSL : la variable de Desktop ne passe pas forcément la frontière,
    # mais Desktop pilote le CLI par des tubes, jamais par un terminal.
    if entrypoint and not claude_stdin_is_tty(env):
        return "desktop"
    return None


def kind_of(hook):
    name = hook.get("hook_event_name")
    if name == "Stop":
        # Des tâches de fond vont relancer l'agent : il n'a pas vraiment fini.
        return None if hook.get("background_tasks") else "done"
    if name == "StopFailure":
        return "needs-input"
    if name == "Notification":
        return "needs-input" if hook.get("notification_type") in NEEDS_INPUT_NOTIFICATIONS else None
    if name == "PreToolUse":
        return "needs-input" if hook.get("tool_name") == "AskUserQuestion" else None
    if name in ("UserPromptSubmit", "SessionEnd"):
        return "dismiss"
    return None


def translate(hook, env):
    if not isinstance(hook, dict):
        return None
    kind = kind_of(hook)
    where = surface(env)
    if kind is None or where is None:
        return None
    session = str(hook.get("session_id") or "inconnue")[:128]
    event = {"v": 1, "kind": kind, "session": session}
    if where == "desktop":
        event["source"] = "claude-desktop"
        event["focus"] = {"process": "claude.exe"}
    else:
        event["source"] = "claude-code"
        # Terminal intégré de VS Code (session WSL distante comprise), sinon Windows Terminal.
        process = "Code.exe" if env.get("TERM_PROGRAM") == "vscode" else "WindowsTerminal.exe"
        event["focus"] = {"process": process}
    return event


def send(event):
    with open(os.path.join(HERE, "endpoint.json"), encoding="utf-8") as f:
        endpoint = json.load(f)
    curl = shutil.which("curl.exe") or "/mnt/c/Windows/System32/curl.exe"
    if not os.path.exists(curl):
        curl = shutil.which("curl") or "curl"
    null = "NUL" if curl.lower().endswith(".exe") else "/dev/null"
    # Processus détaché (nouvelle session) : il survit à ce script, qui rend la main aussitôt.
    # App arrêtée, curl.exe met ~1,3 s à échouer : personne ne l'attend.
    proc = subprocess.Popen(
        [
            curl, "-s", "-m", "2", "-o", null,
            "-H", "Content-Type: application/json",
            "-H", f"X-ReversePrompt-Token: {endpoint['token']}",
            "--data-binary", "@-",
            f"http://127.0.0.1:{int(endpoint['port'])}/event",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    proc.stdin.write(json.dumps(event).encode("utf-8"))
    proc.stdin.close()


def main():
    try:
        hook = json.loads(sys.stdin.buffer.read(MAX_INPUT) or b"null")
        event = translate(hook, os.environ)
        if "--print" in sys.argv[1:]:
            print(json.dumps(event))
        elif event is not None:
            send(event)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
