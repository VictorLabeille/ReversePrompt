#!/usr/bin/env python3
# Teste install.py sur des copies : fusion avec des hooks existants, idempotence,
# désinstallation qui rend le fichier d'origine. Ne touche à aucun vrai réglage.
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.join(os.path.dirname(HERE), "install.py")

# Réglages existants typiques : d'autres hooks, dont un sur un événement que l'on utilise aussi.
ORIGINAL = {
    "model": "opus",
    "hooks": {
        "PreToolUse": [
            {"matcher": "Write|Edit|Bash", "hooks": [{"type": "command", "command": "python3 ~/.claude/hooks/guard.py"}]}
        ],
        "Stop": [{"hooks": [{"type": "command", "command": "notify-send fini"}]}],
        "PostToolUse": [],
    },
    "statusLine": {"type": "command", "command": "x"},
}


def run(*args):
    r = subprocess.run([sys.executable, INSTALL, *args], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr + r.stdout
    return r.stdout


def load(path):
    return json.load(open(path, encoding="utf-8"))


with tempfile.TemporaryDirectory() as tmp:
    app, wsl, win = (os.path.join(tmp, d) for d in ("app", "wsl", "win"))
    os.makedirs(app)
    os.makedirs(wsl)
    open(os.path.join(app, "token"), "w").write("ab" * 32)
    open(os.path.join(app, "config.json"), "w").write('{"port": 47999}')
    settings = os.path.join(wsl, "settings.json")
    json.dump(ORIGINAL, open(settings, "w"), indent=2)
    common = ["--claude-dir", wsl, "--windows-claude-dir", win, "--app-dir", app]

    run(*common)
    first = load(settings)
    assert first["model"] == "opus" and first["statusLine"] == ORIGINAL["statusLine"]
    assert first["hooks"]["PreToolUse"][0] == ORIGINAL["hooks"]["PreToolUse"][0], "hook existant modifié"
    ours = [g for g in first["hooks"]["PreToolUse"] if g.get("matcher") == "AskUserQuestion"]
    assert len(ours) == 1 and ours[0]["hooks"][0]["async"] is True
    assert "async" not in first["hooks"]["SessionEnd"][0]["hooks"][0], "SessionEnd WSL doit rester synchrone"
    assert load(os.path.join(win, "settings.json"))["hooks"]["SessionEnd"][0]["hooks"][0]["async"] is True
    # Titre d'onglet : côté WSL seulement, hooks synchrones et variable qui coupe celui de Claude.
    title = [h for g in first["hooks"]["SessionStart"] for h in g["hooks"]]
    assert len(title) == 1 and title[0]["command"].endswith("notify.py --title") and "async" not in title[0]
    assert sum(h["command"].endswith("--title") for g in first["hooks"]["UserPromptSubmit"] for h in g["hooks"]) == 1
    assert first["env"] == {"CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1"}
    win_settings = load(os.path.join(win, "settings.json"))
    assert "env" not in win_settings and "SessionStart" not in win_settings["hooks"]
    assert load(os.path.join(wsl, "reverse-prompt", "endpoint.json")) == {"port": 47999, "token": "ab" * 32}
    assert os.path.exists(os.path.join(win, "reverse-prompt", "notify.ps1"))
    backups = [f for f in os.listdir(wsl) if f.endswith(".bak")]
    assert len(backups) == 1 and load(os.path.join(wsl, backups[0])) == ORIGINAL

    out = run(*common)
    assert load(settings) == first, "deuxième installation différente"
    assert out.count("déjà à jour") == 2, out
    assert len([f for f in os.listdir(wsl) if f.endswith(".bak")]) == 1, "sauvegarde inutile"

    run(*common, "--uninstall")
    assert load(settings) == ORIGINAL, "désinstallation incomplète"
    assert load(os.path.join(win, "settings.json")) == {}
    assert not os.path.exists(os.path.join(wsl, "reverse-prompt"))

    # Un fichier illisible n'est jamais écrasé.
    open(settings, "w").write("{ pas du json")
    r = subprocess.run([sys.executable, INSTALL, *common, "--target", "wsl"], capture_output=True, text=True)
    assert r.returncode != 0 and open(settings).read() == "{ pas du json"

    # Le vrai fichier de l'utilisateur, copié (nos hooks y sont peut-être déjà) : l'aller-retour
    # rend exactement ce qui n'est pas à nous.
    real = os.path.expanduser("~/.claude/settings.json")
    if os.path.exists(real):
        sys.path.insert(0, os.path.dirname(INSTALL))
        from install import strip_ours

        shutil.copy(real, settings)
        foreign = strip_ours(load(settings))
        run(*common, "--target", "wsl")
        run(*common, "--target", "wsl", "--uninstall")
        assert load(settings) == foreign, "copie du vrai fichier modifiée après aller-retour"

print("install.py : ok")
