#!/usr/bin/env python3
# Installe (ou désinstalle) les hooks ReversePrompt de Claude Code et Claude Desktop.
#
#   python3 adapters/claude/install.py                 installe côté WSL et côté Windows
#   python3 adapters/claude/install.py --target wsl    un seul côté (wsl | windows | all)
#   python3 adapters/claude/install.py --uninstall     retire hooks et fichiers
#   python3 adapters/claude/install.py --dry-run       montre le résultat sans rien écrire
#
# Côté WSL : ~/.claude/settings.json (CLI dans WSL, et sessions Desktop lancées dans WSL).
# Côté Windows : %USERPROFILE%\.claude\settings.json (onglet Code de Claude Desktop).
#
# Règles : les réglages existants sont **fusionnés**, jamais écrasés ; une copie datée du
# fichier est faite avant toute écriture ; relancer l'installation ne change rien ; nos hooks se
# reconnaissent à leur commande (MARKER). Le jeton et le port sont copiés depuis le dossier de
# données de l'app, qui doit donc avoir été lancée une fois.

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
APP_ID = "io.github.victorlabeille.reverseprompt"
MARKER = "reverse-prompt/notify"
NOTIFICATION_MATCHER = "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input"

# Événement → matcher (None : tous). Voir docs/adapters/claude.md pour le choix des événements.
EVENTS = {
    "Stop": None,
    "StopFailure": None,
    "Notification": NOTIFICATION_MATCHER,
    "PreToolUse": "AskUserQuestion",
    "UserPromptSubmit": None,
    "SessionEnd": None,
}

# Côté WSL seulement : titre d'onglet unique posé par le hook (notify.py --title), pour que
# l'app retrouve l'onglet de la session dans Windows Terminal. Synchrone : Claude n'émet la
# séquence que s'il lit la sortie du hook. La variable coupe le titre que Claude écrit
# lui-même, qui écraserait le nôtre (docs/adapters/claude.md, « Titre de l'onglet »).
TITLE_EVENTS = ("SessionStart", "UserPromptSubmit")
TITLE_ENV = ("CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "1")


def handler(command, event, target):
    h = {"type": "command", "command": command}
    # Tout part en arrière-plan : Claude n'attend jamais le hook. Exception côté WSL : à la fin
    # de session, un hook en arrière-plan risque d'être tué avant d'avoir envoyé ; le script
    # WSL rend la main en quelques dizaines de ms (curl.exe détaché), il reste donc synchrone.
    if not (event == "SessionEnd" and target == "wsl"):
        h["async"] = True
    return h


def is_ours(h):
    return isinstance(h, dict) and MARKER in str(h.get("command", ""))


# Retire nos gestionnaires, et côté WSL notre variable. Un groupe, un événement, ou les clés
# `hooks` et `env` que ce retrait laisse vides disparaissent ; ce qui était déjà vide avant
# reste tel quel. Limite : une variable identique posée à la main serait retirée aussi.
def strip_ours(settings, target="wsl"):
    env = settings.get("env")
    name, value = TITLE_ENV
    if target == "wsl" and isinstance(env, dict) and env.get(name) == value:
        del env[name]
        if not env:
            del settings["env"]
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return settings
    for event in list(hooks):
        groups = hooks[event]
        if not isinstance(groups, list):
            continue
        kept, removed = [], False
        for group in groups:
            if isinstance(group, dict) and isinstance(group.get("hooks"), list):
                inner = [h for h in group["hooks"] if not is_ours(h)]
                if len(inner) != len(group["hooks"]):
                    removed = True
                    if not inner:
                        continue
                    group = {**group, "hooks": inner}
            kept.append(group)
        if kept or not removed:
            hooks[event] = kept
        else:
            del hooks[event]
            if not hooks:
                del settings["hooks"]
    return settings


def merge(settings, command, target):
    settings = strip_ours(json.loads(json.dumps(settings)), target)
    hooks = settings.setdefault("hooks", {})
    for event, matcher in EVENTS.items():
        group = {"hooks": [handler(command, event, target)]}
        if matcher:
            group = {"matcher": matcher, **group}
        hooks.setdefault(event, []).append(group)
    if target == "wsl":
        for event in TITLE_EVENTS:
            hooks.setdefault(event, []).append({"hooks": [{"type": "command", "command": command + " --title"}]})
        name, value = TITLE_ENV
        settings.setdefault("env", {})[name] = value
    return settings


def windows_env(name):
    out = subprocess.run(["cmd.exe", "/d", "/c", f"echo %{name}%"], capture_output=True, text=True, cwd="/mnt/c")
    return out.stdout.strip()


def to_wsl(path):
    return subprocess.run(["wslpath", "-u", path], capture_output=True, text=True, check=True).stdout.strip()


def read_endpoint(app_dir):
    try:
        with open(os.path.join(app_dir, "token"), encoding="utf-8") as f:
            token = f.read().strip()
    except OSError:
        sys.exit(f"Jeton introuvable dans {app_dir} : lancer ReversePrompt une première fois.")
    port = 47625
    try:
        with open(os.path.join(app_dir, "config.json"), encoding="utf-8") as f:
            port = int(json.load(f).get("port", port))
    except (OSError, ValueError):
        pass
    return {"port": port, "token": token}


def load_settings(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        sys.exit(f"{path} n'est pas un JSON valide ({e}) : rien n'a été modifié.")
    if not isinstance(data, dict):
        sys.exit(f"{path} n'est pas un objet JSON : rien n'a été modifié.")
    return data


def write_settings(path, settings, dry_run):
    before = load_settings(path)
    if before == settings:
        print(f"  {path} : déjà à jour")
        return
    text = json.dumps(settings, indent=2, ensure_ascii=False) + "\n"
    if dry_run:
        print(f"  {path} : serait réécrit ainsi :\n{text}")
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        backup = f"{path}.reverse-prompt-{time.strftime('%Y%m%d-%H%M%S')}.bak"
        shutil.copy2(path, backup)
        print(f"  sauvegarde : {backup}")
    tmp = path + ".reverse-prompt.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    json.loads(open(tmp, encoding="utf-8").read())  # relecture avant de remplacer
    os.replace(tmp, path)
    print(f"  {path} : mis à jour")


def install_files(files_dir, script, endpoint, dry_run):
    if dry_run:
        return
    os.makedirs(files_dir, exist_ok=True)
    shutil.copy2(os.path.join(HERE, script), os.path.join(files_dir, script))
    endpoint_path = os.path.join(files_dir, "endpoint.json")
    with open(endpoint_path, "w", encoding="utf-8") as f:
        json.dump(endpoint, f)
    try:
        os.chmod(endpoint_path, 0o600)
    except OSError:
        pass


def remove_files(files_dir, dry_run):
    if os.path.isdir(files_dir) and not dry_run:
        shutil.rmtree(files_dir)
        print(f"  {files_dir} : supprimé")


def targets(args):
    result = []
    if args.target in ("wsl", "all"):
        claude_dir = args.claude_dir or os.path.expanduser("~/.claude")
        files_dir = os.path.join(claude_dir, "reverse-prompt")
        command = f"python3 {os.path.join(files_dir, 'notify.py')}"
        result.append(("wsl", claude_dir, files_dir, "notify.py", command))
    if args.target in ("windows", "all"):
        if args.windows_claude_dir:
            claude_dir, win_dir = args.windows_claude_dir, args.windows_claude_dir
        else:
            profile = windows_env("USERPROFILE")
            claude_dir, win_dir = to_wsl(profile + "\\.claude"), profile + "\\.claude"
        files_dir = os.path.join(claude_dir, "reverse-prompt")
        script = (win_dir.replace("\\", "/") + "/reverse-prompt/notify.ps1")
        command = f'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{script}"'
        result.append(("windows", claude_dir, files_dir, "notify.ps1", command))
    return result


def main():
    p = argparse.ArgumentParser(description="Hooks ReversePrompt pour Claude Code et Claude Desktop")
    p.add_argument("--target", choices=["wsl", "windows", "all"], default="all")
    p.add_argument("--uninstall", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    # Pour les tests : travailler sur des copies au lieu des vrais dossiers.
    p.add_argument("--claude-dir", help=argparse.SUPPRESS)
    p.add_argument("--windows-claude-dir", help=argparse.SUPPRESS)
    p.add_argument("--app-dir", help=argparse.SUPPRESS)
    args = p.parse_args()

    endpoint = None
    if not args.uninstall:
        app_dir = args.app_dir or to_wsl(windows_env("APPDATA") + "\\" + APP_ID)
        endpoint = read_endpoint(app_dir)

    for name, claude_dir, files_dir, script, command in targets(args):
        print(f"{name} :")
        settings_path = os.path.join(claude_dir, "settings.json")
        settings = load_settings(settings_path)
        if args.uninstall:
            write_settings(settings_path, strip_ours(settings, name), args.dry_run)
            remove_files(files_dir, args.dry_run)
        else:
            install_files(files_dir, script, endpoint, args.dry_run)
            write_settings(settings_path, merge(settings, command, name), args.dry_run)

    if not args.uninstall and not args.dry_run and shutil.which("curl.exe"):
        r = subprocess.run(
            ["curl.exe", "-s", "-m", "2", f"http://127.0.0.1:{endpoint['port']}/health"],
            capture_output=True, text=True, cwd="/mnt/c",
        )
        print("app : " + ("à l'écoute" if r.stdout.startswith("reverse-prompt") else "ne répond pas (lancée ?)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
