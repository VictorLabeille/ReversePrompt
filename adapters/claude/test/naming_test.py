#!/usr/bin/env python3
# Titre de session généré par l'adaptateur (notify.py --title, docs/adapters/claude.md) : un
# faux `claude` remplace le vrai, rien n'est envoyé au modèle.
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
NOTIFY = os.path.join(os.path.dirname(HERE), "notify.py")
SESSION = "5F0C2D1E-aaaa"
MARK = "5f0c2d"

tmp = tempfile.mkdtemp(prefix="reverse-prompt-naming-")
fake = os.path.join(tmp, "fake-claude")
with open(fake, "w") as f:
    # Garde ce qu'il reçoit pour vérifier la consigne, et répond comme le ferait le modèle.
    f.write(f'#!/bin/sh\ncat > "{tmp}/received"\nenv > "{tmp}/env"\necho "« Titre factice. »"\n')
os.chmod(fake, 0o755)
transcript = os.path.join(tmp, "transcript.jsonl")
open(transcript, "w").close()

ENV = {
    **{k: v for k, v in os.environ.items() if not k.startswith("CLAUDE") and k != "TERM_PROGRAM"},
    "CLAUDE_CODE_ENTRYPOINT": "cli",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1",
    "CLAUDE_CODE_EXECPATH": fake,
    "REVERSE_PROMPT_STATE_DIR": os.path.join(tmp, "titles"),
}


def title_hook(prompt, event="UserPromptSubmit", env=ENV):
    hook = {"hook_event_name": event, "session_id": SESSION, "cwd": "/home/v/projet",
            "transcript_path": transcript, "prompt": prompt}
    out = subprocess.run([sys.executable, NOTIFY, "--title"], input=json.dumps(hook).encode(),
                         env=env, capture_output=True, check=True).stdout
    return json.loads(out) if out.strip() else {}


def wait_for(path):
    end = time.monotonic() + 5
    while not os.path.exists(path):
        assert time.monotonic() < end, f"{path} jamais écrit"
        time.sleep(0.05)


def tab(out):
    seq = out.get("terminalSequence", "")
    return seq[len("\x1b]2;"):-1] if seq else None


def session_title(out):
    return out.get("hookSpecificOutput", {}).get("sessionTitle")


# 1er message : génération lancée, pas encore de titre ; l'onglet garde le dossier.
out = title_hook("pourquoi le build Tauri échoue ?")
assert session_title(out) is None and tab(out) == f"projet · {MARK}", out
wait_for(os.path.join(tmp, "titles", f"{SESSION}.title"))
received = open(os.path.join(tmp, "received"), encoding="utf-8").read()
assert "pourquoi le build Tauri échoue ?" in received and "Projet : projet" in received
assert "REVERSE_PROMPT_NAMING=1" in open(os.path.join(tmp, "env")).read()

# 2e message : le titre généré est posé, nettoyé, et passe dans l'onglet.
out = title_hook("/clear")
assert session_title(out) == "Titre factice", out
assert tab(out) == f"Titre factice · {MARK}", out
# Claude l'écrit dans le journal comme un /rename ; il n'est pas reposé ensuite.
with open(transcript, "a") as f:
    f.write(json.dumps({"type": "custom-title", "customTitle": "Titre factice", "sessionId": SESSION}, separators=(",", ":")) + "\n")
out = title_hook("et maintenant ?")
assert session_title(out) is None and tab(out) == f"Titre factice · {MARK}", out
state = json.load(open(os.path.join(tmp, "titles", f"{SESSION}.json"), encoding="utf-8"))
assert state["prompts"] == ["pourquoi le build Tauri échoue ?", "et maintenant ?"], state

# Génération plus ancienne qui finit après une plus récente : ignorée.
titles = os.path.join(tmp, "titles")
json.dump({"title": "Riche", "prompts": 3}, open(os.path.join(titles, f"{SESSION}.title"), "w"))
subprocess.run([sys.executable, NOTIFY, "--name-session", SESSION], env=ENV, check=True)
assert json.load(open(os.path.join(titles, f"{SESSION}.title")))["title"] == "Riche"

# État illisible (dossier à la place du fichier) : le titre d'onglet sort quand même.
state_file = os.path.join(titles, f"{SESSION}.json")
saved = open(state_file, encoding="utf-8").read()
os.remove(state_file); os.mkdir(state_file)
assert tab(title_hook("message")) == f"Titre factice · {MARK}"
os.rmdir(state_file); open(state_file, "w", encoding="utf-8").write(saved)

# /rename de l'utilisateur : jamais remplacé, même quand une nouvelle génération aboutit.
with open(transcript, "a") as f:
    f.write(json.dumps({"type": "custom-title", "customTitle": "Mon nom", "sessionId": SESSION}, separators=(",", ":")) + "\n")
json.dump({"title": "Autre titre"}, open(os.path.join(tmp, "titles", f"{SESSION}.title"), "w"))
out = title_hook("encore")
assert session_title(out) is None and tab(out) == f"Mon nom · {MARK}", out
out = title_hook("", event="SessionStart")
assert tab(out) == f"Mon nom · {MARK}", out

# Le `claude -p` de génération ne génère rien lui-même ; titre de Claude actif : rien non plus.
os.remove(transcript); open(transcript, "w").close()
for env in ({**ENV, "REVERSE_PROMPT_NAMING": "1", "CLAUDE_CODE_ENTRYPOINT": "sdk-cli"},
            {**ENV, "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "0"}):
    other = {**env, "REVERSE_PROMPT_STATE_DIR": os.path.join(tmp, "other")}
    assert session_title(title_hook("bonjour", env=other)) is None
    assert not os.path.exists(os.path.join(tmp, "other"))
print("titre de session : ok")
