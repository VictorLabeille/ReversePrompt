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
#   notify.py --title    écrit sur stdout le titre d'onglet de la session (hook synchrone de
#                        SessionStart et UserPromptSubmit), sans rien envoyer

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
# Posée par l'installeur dans les réglages : Claude n'écrit plus le titre du terminal, c'est ce
# script qui le fait. Sans elle, Claude écraserait le titre à chaque changement d'état.
TITLE_OFF_VAR = "CLAUDE_CODE_DISABLE_TERMINAL_TITLE"
TITLE_EVENTS = {"SessionStart", "UserPromptSubmit"}
MARKER_LEN = 6


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


# Terminal où l'onglet porte le titre de ce script : Windows Terminal, titre de Claude coupé.
# Le terminal de VS Code a un titre d'onglet que la fenêtre ne montre pas : sans objet.
def owns_title(env):
    return (
        env.get(TITLE_OFF_VAR) == "1"
        and surface(env) == "terminal"
        and env.get("TERM_PROGRAM") != "vscode"
    )


# Marque de la session dans le titre de l'onglet : le début de son identifiant. C'est le
# fragment que l'app cherche dans les titres (focus.title) ; le nom du dossier n'est là que
# pour l'œil, car il peut changer en cours de session.
def tab_marker(hook):
    sid = "".join(c for c in str(hook.get("session_id") or "") if c.isalnum()).lower()
    return sid[:MARKER_LEN] or None


def tab_title(hook, env):
    if not isinstance(hook, dict) or hook.get("hook_event_name") not in TITLE_EVENTS:
        return None
    marker = tab_marker(hook)
    if not owns_title(env) or marker is None:
        return None
    folder = os.path.basename(str(hook.get("cwd") or "").rstrip("/")) or "claude"
    folder = "".join(c for c in folder if c.isprintable())[:40]
    return f"{folder} · {marker}"


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
        marker = tab_marker(hook) if owns_title(env) else None
        if marker:
            event["focus"]["title"] = marker
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
        if "--title" in sys.argv[1:]:
            # OSC 2 : titre de la fenêtre, donc de l'onglet dans Windows Terminal. Claude Code
            # l'écrit lui-même (un hook n'a pas de terminal) ; voir docs/adapters/claude.md.
            title = tab_title(hook, os.environ)
            if title:
                print(json.dumps({"terminalSequence": f"\x1b]2;{title}\x07"}))
            return 0
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
