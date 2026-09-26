# Adaptateur Claude (Claude Code CLI et Claude Desktop)

Ce document est le relevé des faits sur lesquels repose l'adaptateur Claude, puis la description
de l'adaptateur lui-même. Un agent qui ajoute un autre outil (Codex, OpenCode…) s'en sert de
modèle : **faits vérifiés d'abord, avec leur source ; traduction vers le contrat ensuite.**

Le contrat que l'adaptateur doit produire est décrit dans `docs/event-contract.md`.

## 1. Faits vérifiés (relevé du 2026-09-26)

Sources : référence officielle des hooks (`https://code.claude.com/docs/en/hooks.md`), pages
`desktop.md`, `desktop-wsl.md` et `env-vars.md` du même site ; Claude Code 2.1.283 dans WSL ;
Claude Desktop 1.52386.6.0 (paquet MSIX) sur le poste de Victor.

### Configuration des hooks

- Les hooks se déclarent dans `~/.claude/settings.json` (portée utilisateur), clé `hooks`,
  sur trois niveaux : **événement → groupe (`matcher`) → gestionnaires (`hooks: [...]`)**.
- Gestionnaire `type: "command"` : l'entrée JSON arrive sur **stdin**. Champ `async: true` :
  Claude Code lance le hook **sans l'attendre** (pas de `timeout` appliqué, sa sortie ne
  décide de rien). C'est le mode utilisé ici : un hook de notification ne doit jamais retarder
  l'agent.
- Gestionnaire `type: "http"` : Claude Code POSTe lui-même le JSON. **Écarté** : il est
  synchrone (le tour attend la réponse) et, app arrêtée, Windows met ~1,3 s à refuser la
  connexion ; il enverrait en outre le JSON brut de l'outil, que le cœur ne doit jamais voir.
- Les gestionnaires identiques déclarés dans plusieurs fichiers ne tournent qu'une fois ; les
  hooks de niveaux différents s'additionnent.
- `SessionEnd` : budget global de 1,5 s pour tous ses hooks (sans objet en `async`).
- Sous Windows, une commande en forme « shell » passe par **Git Bash** s'il est installé
  (c'est le cas sur le poste : `C:\Program Files\Git\bin\bash.exe`), sinon par PowerShell.

### Champs d'entrée utiles

Communs à tous les événements : `session_id`, `cwd`, `hook_event_name`, `transcript_path`
(non lu : ce serait lire la conversation).

| Événement | Champs propres utilisés | Quand |
| --- | --- | --- |
| `Stop` | `background_tasks` (tableau), `stop_hook_active` | fin de réponse de l'agent principal ; **pas** sur interruption par l'utilisateur |
| `StopFailure` | `error` | fin de tour sur erreur d'API (remplace `Stop`) |
| `Notification` | `notification_type`, `message`, `title` | voir tableau suivant |
| `UserPromptSubmit` | — (`prompt` n'est **pas** lu) | l'utilisateur envoie un message |
| `SessionEnd` | `reason` | fin de session (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`) |
| `PreToolUse` | `tool_name` | avant chaque outil ; filtré sur `AskUserQuestion` |

Types de `Notification` (champ `notification_type`, aussi valeur du `matcher`) :

| Type | Sens | Retenu |
| --- | --- | --- |
| `permission_prompt` | demande d'autorisation restée ~6 s sans frappe au clavier | oui → `needs-input` |
| `elicitation_dialog`, `elicitation_url_dialog` | formulaire ou URL d'un serveur MCP, ~6 s sans frappe | oui → `needs-input` |
| `agent_needs_input` | une session d'arrière-plan attend (vue agents ouverte) | oui → `needs-input` |
| `idle_prompt` | réponse finie depuis ~60 s sans frappe | **non** : doublon de `Stop`, et relancerait une île que Victor a fermée |
| `agent_completed` | une session d'arrière-plan a fini (vue agents ouverte) | **non** : son propre `Stop` suffit |
| `auth_success`, `elicitation_complete`, `elicitation_response`, `quota_auto_resume_*` | informatifs | non |

Le délai de ~6 s de `permission_prompt` est voulu : il évite de notifier quand Victor est
déjà devant le terminal. `PermissionRequest` (immédiat) est écarté pour cette raison.

Dans les sessions hébergées par le SDK (Claude Desktop, extension VS Code), `permission_prompt`
part ~6 s après la demande **sans** être repoussé par la frappe (depuis la v2.1.233).

### Claude Desktop — onglet Code

- **Même configuration que le CLI** (`desktop.md`, « Shared configuration ») : les hooks de
  `~/.claude/settings.json` s'appliquent aux sessions Desktop. Sous Windows, `~` est le profil
  utilisateur : `C:\Users\<nom>\.claude\settings.json`. Sur le poste, ce dossier existe
  (sous-dossiers `backups`, `sessions`) mais **aucun `settings.json`** avant l'installation.
- **Sessions WSL** (`desktop-wsl.md`) : l'onglet Code peut lancer la session **dans une
  distribution WSL**. Claude Code y tourne sous Linux et lit alors le `~/.claude/settings.json`
  **de WSL**. Un hook WSL peut donc venir du CLI dans un terminal **ou** de Claude Desktop.
- Le processus de fenêtre de Claude Desktop est `claude.exe` (paquet MSIX
  `Claude_…_x64__pzs8sxrjxfjjc`, exécutable `app\Claude.exe`).

### Distinguer le CLI de Claude Desktop

- **Observé, non documenté :** la variable `CLAUDE_CODE_ENTRYPOINT` vaut `cli` dans un hook du
  CLI lancé depuis un terminal (relevé dans cette session). Les journaux de Claude Desktop
  listent `CLAUDE_CODE_ENTRYPOINT` parmi les variables qu'il transmet à ses sessions ; **sa
  valeur n'a pas été relevée**. Règle retenue : `cli` → terminal, toute autre valeur non vide →
  Claude Desktop.
- **Repli dans WSL** (la variable peut ne pas franchir la frontière Windows → WSL) : Claude
  Code exporte `CLAUDE_PID` (observé, non documenté). Si l'entrée standard de ce processus est
  un terminal (`/proc/$CLAUDE_PID/fd/0` → `/dev/pts/*`), c'est le CLI ; Desktop le pilote par
  des tubes.
- **À confirmer par Victor** avec une vraie session Desktop (`docs/acceptance.md`).

### Claude Desktop — conversations (chat)

**Aucun mécanisme propre trouvé** (point d'arrêt 1 du brief, décision laissée à Victor) :

- Pas de hook ni d'API documentés pour la fin d'une réponse de chat. Une demande publique
  existe (anthropics/claude-code, issue #39462).
- Claude Desktop a un réglage de notifications système pour les fins de réponse (« Response
  completions », signalé dans l'issue #50480 ; non vérifié ici).
- L'API Windows qui lit les notifications des autres apps (`UserNotificationListener`) exige
  une **capacité déclarée dans un manifeste de paquet** et l'accord de l'utilisateur : une app
  Tauri installée en MSI/NSIS n'a pas d'identité de paquet (Microsoft Learn,
  « Notification listener », relu le 2026-09-26).

Les options et leurs risques sont présentées dans le rapport de session et dans la jumelle
Obsidian. Rien n'est implémenté pour le chat en attendant.

### Poste de Victor (relevé 2026-09-26)

- WSL Debian, réseau **NAT** ; `curl.exe` de Windows : 8.21.0, `/mnt/c/Windows/System32/curl.exe`.
- WSL : `python3` 3.13 présent, **pas de `jq`**, `setsid` présent.
- Windows : Rust 1.96 (MSVC), Node 24.18, npm 11.16, Git Bash, Windows Terminal 1.24.
- Le titre de la fenêtre Windows Terminal reprend le titre de la session Claude Code.

## 2. L'adaptateur

_(Rempli au jalon J5 / J7.)_
