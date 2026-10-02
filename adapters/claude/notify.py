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
#                        SessionStart et UserPromptSubmit), et son titre de session une fois
#                        généré ; sans rien envoyer à l'app
#   notify.py --name-session <id>
#                        génère le titre de session (lancé détaché par --title, jamais à la main)

import json
import mmap
import os
import shutil
import subprocess
import sys
import time

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

# Titre de session. La variable ci-dessus coupe aussi le titre que Claude génère lui-même
# (`claude -r` montrerait le premier message) : ce script le génère à sa place, au 1er puis au
# 3e message, et le pose au message suivant. Voir docs/adapters/claude.md.
NAMING_AT = (1, 3)
KEPT_PROMPTS = 3
PROMPT_CHARS = 600
SESSION_TITLE_CHARS = 60
TAB_TITLE_CHARS = 40
NAMING_TIMEOUT_S = 90
STATE_MAX_AGE_S = 30 * 86400
# Posée dans l'environnement du `claude -p` qui génère le titre : jamais de génération en boucle.
CHILD_VAR = "REVERSE_PROMPT_NAMING"
NAMING_PROMPT = """Tu nommes une session de développement pour qu'on la retrouve dans une longue liste.
Le titre est un nom, pas une phrase : un groupe nominal de deux à cinq mots, majuscule au premier
mot seulement (plus les noms propres, sigles et identifiants, recopiés tels quels).
Commence par la chose la plus précise que l'utilisateur nomme : composant, fonctionnalité,
fichier, fonction, erreur, concept. Pas de verbe de demande (corriger, ajouter, vérifier…) ni
de nom abstrait qui le remplace (correction, analyse, vérification…). Une question se nomme
par son sujet. Ne reprends pas le ton ni les jugements du message.
Écris dans la langue des messages. Réponds par le titre seul, sans guillemets ni point final.

Projet : {folder}

Premiers messages de l'utilisateur :
{prompts}"""


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
    name = session_name(hook) or folder_of(hook)
    return f"{clean(name, TAB_TITLE_CHARS)} · {marker}"


def clean(text, limit):
    text = " ".join("".join(c if c.isprintable() else " " for c in str(text)).split())
    return text[:limit].rstrip()


def folder_of(hook):
    return os.path.basename(str(hook.get("cwd") or "").rstrip("/")) or "claude"


# --- Titre de session -------------------------------------------------------------------

def naming_enabled(hook, env):
    return (
        isinstance(hook, dict)
        and env.get(TITLE_OFF_VAR) == "1"
        and env.get(CHILD_VAR) != "1"
        and surface(env) == "terminal"
        and tab_marker(hook) is not None
    )


def state_dir():
    return os.environ.get("REVERSE_PROMPT_STATE_DIR") or os.path.join(HERE, "titles")


def state_path(hook, suffix):
    return os.path.join(state_dir(), f"{session_file_id(hook)}.{suffix}")


# Identifiant de session réduit aux caractères sûrs pour un nom de fichier.
def session_file_id(hook):
    return "".join(c for c in str(hook.get("session_id") or "") if c.isalnum() or c == "-")[:128]


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, type(default)) else default
    except (OSError, ValueError):
        return default


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False)
    os.replace(tmp, path)


# Dernier titre écrit dans le journal de la session : `/rename` ou `sessionTitle` d'un hook
# (custom-title), titre de Claude (ai-title). La dernière occurrence fait foi. Le journal peut
# peser des centaines de Mo (images) : projeté en mémoire (mmap), jamais copié, et lu une seule
# fois par appel du hook.
_titles_cache = {}


def transcript_titles(hook):
    path = hook.get("transcript_path")
    if not path:
        return {}
    if path not in _titles_cache:
        _titles_cache[path] = read_transcript_titles(path)
    return _titles_cache[path]


def read_transcript_titles(path):
    found = {}
    try:
        with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as data:
            for kind, key in ((b"custom-title", "customTitle"), (b"ai-title", "aiTitle")):
                at = data.rfind(b'"type":"' + kind + b'"')
                if at < 0:
                    continue
                start = data.rfind(b"\n", 0, at) + 1
                end = data.find(b"\n", at)
                try:
                    line = json.loads(data[start:end if end >= 0 else len(data)])
                    found[kind.decode()] = str(line.get(key) or "") or None
                except ValueError:
                    pass
    except (OSError, ValueError):
        # Fichier absent, illisible ou vide (mmap refuse une taille nulle).
        pass
    return found


# Nom affiché dans l'onglet : le titre de la session s'il existe, sinon rien (dossier).
def session_name(hook):
    if not hook.get("session_id"):
        return None
    titles = transcript_titles(hook)
    state = read_json(state_path(hook, "json"), {})
    return titles.get("custom-title") or state.get("applied") or titles.get("ai-title")


# Hook synchrone de UserPromptSubmit : retient le message, lance la génération quand il faut,
# et rend le titre généré s'il n'est pas encore posé. Rend le champ `sessionTitle` ou None.
def name_session(hook, env):
    if not naming_enabled(hook, env) or hook.get("hook_event_name") != "UserPromptSubmit":
        return None
    path = state_path(hook, "json")
    state = read_json(path, {})
    titles = transcript_titles(hook)
    custom = titles.get("custom-title")
    # Un titre qui ne vient pas de ce script (`/rename`, ou titre de Claude d'avant
    # l'installation) n'est jamais remplacé.
    if (custom and custom != state.get("applied")) or (titles.get("ai-title") and not state):
        return None
    prompt = clean(hook.get("prompt") or "", PROMPT_CHARS)
    prompts = state.setdefault("prompts", [])
    if prompt and not prompt.startswith("/") and len(prompts) < KEPT_PROMPTS:
        prompts.append(prompt)
    state["folder"] = clean(folder_of(hook), 60)
    naming = len(prompts) in NAMING_AT and state.get("named_at", 0) < len(prompts)
    if naming:
        state["named_at"] = len(prompts)
    title = read_json(state_path(hook, "title"), {}).get("title")
    result = None
    if title and title != state.get("applied"):
        state["applied"] = title
        result = title
    # Écrit avant de lancer la génération : elle relit les messages dans ce fichier.
    write_json(path, state)
    if naming:
        spawn_naming(hook)
    return result


def spawn_naming(hook):
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--name-session", session_file_id(hook)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def claude_command(env):
    return env.get("CLAUDE_CODE_EXECPATH") or shutil.which("claude")


# Processus détaché : demande un titre à un `claude -p` court (modèle léger, sans outils, sans
# réglages ni hooks, sans session enregistrée) et l'écrit à côté de l'état de la session.
def generate_title(session_id):
    hook = {"session_id": session_id}
    state = read_json(state_path(hook, "json"), {})
    prompts = state.get("prompts") or []
    claude = claude_command(os.environ)
    if not prompts or not claude:
        return
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION")}
    env[CHILD_VAR] = "1"
    message = NAMING_PROMPT.format(
        folder=state.get("folder") or "?",
        prompts="\n\n".join(f"---\n{p}" for p in prompts),
    )
    out = subprocess.run(
        [
            claude, "-p", "--model", "haiku", "--no-session-persistence",
            "--setting-sources", "local", "--tools", "", "--disable-slash-commands",
            "--strict-mcp-config",
        ],
        input=message.encode("utf-8"), env=env, cwd=state_dir(),
        capture_output=True, timeout=NAMING_TIMEOUT_S,
    )
    lines = [l for l in out.stdout.decode("utf-8", "replace").splitlines() if l.strip()]
    if out.returncode != 0 or not lines:
        return
    title = clean(lines[0].strip(" \t\"'«»“”*#.").strip(), SESSION_TITLE_CHARS)
    # Les générations du 1er et du 3e message peuvent se croiser : celle qui a lu moins de
    # messages ne remplace pas l'autre.
    previous = read_json(state_path(hook, "title"), {})
    if title and previous.get("prompts", 0) <= len(prompts):
        write_json(state_path(hook, "title"), {"title": title, "prompts": len(prompts), "at": int(time.time())})
    prune_states()


def prune_states():
    limit = time.time() - STATE_MAX_AGE_S
    try:
        for entry in os.scandir(state_dir()):
            if entry.is_file() and entry.stat().st_mtime < limit:
                os.remove(entry.path)
    except OSError:
        pass


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
        if sys.argv[1:2] == ["--name-session"] and len(sys.argv) > 2:
            generate_title(sys.argv[2])
            return 0
        hook = json.loads(sys.stdin.buffer.read(MAX_INPUT) or b"null")
        if "--title" in sys.argv[1:]:
            output = {}
            # Le titre de session est un plus : son échec (disque, processus) ne doit pas
            # coûter le titre d'onglet, dont dépend le retour à l'onglet.
            try:
                session_title = name_session(hook, os.environ)
            except Exception:
                session_title = None
            if session_title:
                output["hookSpecificOutput"] = {
                    "hookEventName": "UserPromptSubmit",
                    "sessionTitle": session_title,
                }
            # OSC 2 : titre de la fenêtre, donc de l'onglet dans Windows Terminal. Claude Code
            # l'écrit lui-même (un hook n'a pas de terminal) ; voir docs/adapters/claude.md.
            title = tab_title(hook, os.environ)
            if title:
                output["terminalSequence"] = f"\x1b]2;{title}\x07"
            if output:
                print(json.dumps(output))
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
