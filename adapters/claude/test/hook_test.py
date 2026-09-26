#!/usr/bin/env python3
# Le hook ne doit jamais retenir Claude Code : il sort en 0 et rend la main vite, que l'app
# tourne ou non (port fermé : curl.exe met ~1,3 s à échouer, mais détaché).
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LIMIT_S = 0.5
HOOK = json.dumps({"hook_event_name": "Stop", "session_id": "hook-test"}).encode()

with tempfile.TemporaryDirectory() as tmp:
    shutil.copy(os.path.join(os.path.dirname(HERE), "notify.py"), tmp)
    # Port 9 (discard) : rien n'y écoute, la connexion est refusée.
    json.dump({"port": 9, "token": "00" * 32}, open(os.path.join(tmp, "endpoint.json"), "w"))
    env = {**os.environ, "CLAUDE_CODE_ENTRYPOINT": "cli"}
    worst = 0.0
    for _ in range(5):
        t = time.monotonic()
        r = subprocess.run([sys.executable, os.path.join(tmp, "notify.py")], input=HOOK, env=env)
        worst = max(worst, time.monotonic() - t)
        assert r.returncode == 0
    print(f"hook, app arrêtée : sortie 0, pire durée {worst * 1000:.0f} ms")
    assert worst < LIMIT_S, f"hook trop lent ({worst:.2f} s)"

    # Configuration absente ou cassée : toujours 0, sans bruit.
    os.remove(os.path.join(tmp, "endpoint.json"))
    r = subprocess.run([sys.executable, os.path.join(tmp, "notify.py")], input=HOOK, env=env, capture_output=True)
    assert r.returncode == 0 and not r.stdout and not r.stderr
    r = subprocess.run([sys.executable, os.path.join(tmp, "notify.py")], input=b"{pas du json", env=env, capture_output=True)
    assert r.returncode == 0 and not r.stdout and not r.stderr
print("hook : ok")
