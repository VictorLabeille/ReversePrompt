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
| `SessionStart` | — | début, reprise ou `/clear` d'une session : sert au titre de l'onglet |

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
  CLI interactif lancé depuis un terminal (relevé le 2026-09-26). Le code de Claude Desktop
  (`app.asar`, version 1.52386.6.0) la pose pour les sessions qu'il lance : `claude-desktop`
  ou `claude-desktop-3p` (onglet Code, selon le fournisseur), `local-agent` (Cowork, dans une
  machine virtuelle), et `sdk-ts` par défaut dans son SDK. Règle retenue : `cli` → terminal,
  `claude-desktop*` → Claude Desktop, toute autre valeur → pas de notification (sessions
  sans fenêtre à ramener : `claude -p` dans un script, Cowork).
- **Repli dans WSL** (la variable peut ne pas franchir la frontière Windows → WSL ; le CLI
  pose alors sa propre valeur) : Claude Code exporte `CLAUDE_PID` (observé, non documenté).
  Pour une valeur autre que `cli` et `claude-desktop*`, si l'entrée standard de ce processus
  n'est **pas** un terminal (`/proc/$CLAUDE_PID/fd/0` hors de `/dev/pts/*`), la session est
  tenue pour une session Desktop dans WSL : Desktop pilote le CLI par des tubes. Risque
  connu : un `claude -p` alimenté par un tube dans un script WSL passerait pour Desktop.
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

### Titre de l'onglet (relevé du 2026-09-28, Claude Code 2.1.283)

- Claude Code écrit lui-même le titre du terminal : « Claude Code » tant que la session n'a pas
  de titre, puis le titre généré par l'IA ou celui de `/rename`, précédé d'un symbole d'état
  (`✳`). Deux onglets peuvent donc porter le même titre, surtout en début de session.
- **Les hooks ne reçoivent pas ce titre** : aucun champ de titre ni de nom de session dans leur
  entrée (`hooks.md`). La ligne d'état (`statusline.md`), elle, reçoit `session_name` (nom de
  `/rename` ou titre généré ; absent tant qu'il n'y en a pas) avec `session_id`.
- Un hook peut **écrire** le titre : champ de sortie `terminalSequence`, séquences OSC `0`/`1`/`2`
  autorisées, émises par Claude Code en session interactive seulement (`hooks.md`, « Emit
  terminal notifications »). Claude Code réécrit ensuite son propre titre à chaque changement.
- Observé dans l'exécutable, non documenté : variable `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, et
  réglage `terminalTitleFromRename` (« `/rename` met à jour le titre de l'onglet », vrai par
  défaut).
- **Vérifié le 2026-09-28** (Claude Code lancé dans un pseudo-terminal, séquences OSC relevées) :
  sans la variable, Claude réécrit le titre à chaque changement d'état (`✳ Claude Code`,
  `◐ Claude Code`, puis le titre de la réponse) et écrase celui d'un hook. Avec
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`, qu'elle vienne de l'environnement ou du bloc `env` des
  réglages, Claude n'écrit plus aucun titre et celui du hook reste. Un hook **synchrone** de
  `SessionStart` ou `UserPromptSubmit` qui renvoie `terminalSequence` pose bien le titre.
- **Effet de bord, vérifié le 2026-10-02 (Claude Code 2.1.287)** : la variable coupe aussi la
  **génération du titre de session** par l'IA, pas seulement son écriture dans le terminal. Le
  même composant porte les deux (`disabled: CLAUDE_CODE_DISABLE_TERMINAL_TITLE` à sa création,
  relevé dans l'exécutable). Sans titre IA, `claude -r` affiche le premier message de la session.
  Mesure : trois sessions lancées dans un pseudo-terminal sans la variable → une entrée
  `ai-title` chacune dans le journal ; trois avec → aucune. Côté poste : plus aucune `ai-title`
  dans les sessions ouvertes après l'installation du 2026-09-28.
- Un hook **synchrone** de `SessionStart` ou `UserPromptSubmit` peut poser le titre de session :
  champ `hookSpecificOutput.sessionTitle` (relevé dans le schéma de l'exécutable, non essayé).

## 2. L'adaptateur

Fichiers : `adapters/claude/`.

| Fichier | Rôle |
| --- | --- |
| `notify.py` | hook côté Linux/WSL : traduit, envoie par `curl.exe` détaché |
| `notify.ps1` | hook côté Windows (Claude Desktop, CLI Windows) : mêmes règles, envoi par `Invoke-WebRequest` |
| `install.py` | installe ou retire les hooks des deux côtés, depuis WSL |
| `test/cases.json` | cas de traduction communs aux deux scripts |
| `test/run.py`, `test/install_test.py`, `test/hook_test.py` | tests (`npm run test:adapters`) |

### Traduction

| Signal Claude | Événement du contrat |
| --- | --- |
| `Stop` (sans `background_tasks` en cours) | `done` |
| `StopFailure` | `needs-input` |
| `Notification` `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` | `needs-input` |
| `PreToolUse` sur `AskUserQuestion` | `needs-input` |
| `UserPromptSubmit`, `SessionEnd` | `dismiss` |
| tout le reste | rien |

- `focus.title` = les 6 premiers caractères alphanumériques de `session_id`, en minuscules,
  **seulement** si le titre de l'onglet est celui de l'adaptateur : `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`,
  session CLI, hors terminal de VS Code. C'est la marque que l'app cherche dans les titres
  d'onglet de Windows Terminal. Sans ces conditions, pas de `focus.title` : l'app ramène la
  fenêtre, comme avant.
- `session` = `session_id` (128 caractères au plus). Aucun `text` : l'île tire le sien dans
  `src/messages.json`. Le contenu des messages (`prompt`, `last_assistant_message`, `message`)
  n'est jamais transmis à l'app. Seule exception de lecture : les trois premiers messages de
  l'utilisateur, pour le titre de session (section suivante), envoyés au modèle et nulle part
  ailleurs.
- Où vit la session (règle de la section 1) :

| `CLAUDE_CODE_ENTRYPOINT` | `source` | `focus.process` |
| --- | --- | --- |
| `cli` | `claude-code` | `WindowsTerminal.exe` ; `Code.exe` si `TERM_PROGRAM=vscode` |
| `claude-desktop`, `claude-desktop-3p` | `claude-desktop` | `claude.exe` |
| autre valeur, WSL, entrée du processus Claude hors terminal | `claude-desktop` | `claude.exe` |
| autre valeur, ou absente | — pas de notification — | |

### Titre de l'onglet

`notify.py --title`, hook **synchrone** de `SessionStart` et `UserPromptSubmit` côté WSL,
répond `{"terminalSequence": "ESC ]2;<dossier> · <marque> BEL"}` (exemple :
`ReversePrompt · c7bc2a`) : Claude Code écrit ce titre dans le terminal. Devant la marque, le
titre de la session une fois connu (section suivante), sinon le nom du dossier (`cwd` du hook) :
ils ne sont là que pour l'œil ; seule la marque sert à l'app. Réémis à chaque message,
il se rétablit si quelque chose l'a changé entre-temps. L'installeur pose aussi
`CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` dans le bloc `env` de `~/.claude/settings.json`, sans
quoi Claude écraserait ce titre. Conséquence : l'onglet ne montre plus ni le titre de sujet ni
le symbole d'état de Claude (choix de Victor, 2026-09-28).

### Titre de session

La variable qui protège la marque coupe aussi le titre que Claude génère pour la session
(section 1) : sans rien d'autre, `claude -r` montrerait le premier message. L'adaptateur le
génère donc lui-même (choix de Victor, 2026-10-02 ; écartés : rendre son titre à Claude et
perdre l'onglet précis, `/rename` à la main).

- `notify.py --title` sur `UserPromptSubmit` retient les trois premiers messages (600
  caractères chacun, commandes `/…` exclues) dans `~/.claude/reverse-prompt/titles/<session>.json`.
- Au 1er puis au 3e message, il lance détaché `notify.py --name-session <session>` : un
  `claude -p` court (`--model haiku`, sans outils, sans réglages ni hooks, sans session
  enregistrée, variable `REVERSE_PROMPT_NAMING=1` contre toute boucle), avec une consigne
  inspirée de celle de Claude Code (groupe nominal de deux à cinq mots, sans verbe de demande).
  Réponse en 7 à 20 s, écrite dans `<session>.title`.
- Au message suivant, le hook rend `hookSpecificOutput.sessionTitle` : Claude l'enregistre comme
  un `/rename` (`custom-title` dans le journal), donc visible dans `claude -r`, et l'onglet passe
  à `<titre> · <marque>`.
- **Jamais par-dessus un titre qui ne vient pas de lui** : un `/rename`, ou un titre de Claude
  d'avant l'installation, est lu dans le journal (`transcript_path`, dernière entrée
  `custom-title` ou `ai-title`) et gardé, y compris dans l'onglet.
- Seulement pour les sessions CLI avec la variable posée (terminal de VS Code compris) ;
  fichiers d'état effacés après 30 jours.

Vérifié le 2026-10-02 (session réelle en pseudo-terminal, deux messages) : titre « TCP et UDP »
généré, écrit en `custom-title`, onglet `TCP et UDP · 656704`. `sessionTitle` relevé dans le
schéma de l'exécutable 2.1.287, non documenté dans `hooks.md` au moment du relevé.

Côté Windows, pas de titre : PowerShell démarre trop lentement (~0,3 à 0,5 s) pour un hook
synchrone à chaque message. `notify.ps1` applique la même règle pour `focus.title`, mais la
variable n'y est pas posée : le CLI Windows garde le retour à la fenêtre.

Vérifié le 2026-09-28 : nouvelle session lancée avec les réglages installés → titre
`ReversePrompt · c7bc2a` émis. Les sessions ouvertes **avant** l'installation gardent le titre
de Claude, n'envoient pas de `focus.title` et gardent le retour à la fenêtre.

### Hooks installés

Même commande pour tous les événements ci-dessus, avec les `matcher` de `Notification` et
`PreToolUse`, plus, côté WSL, `notify.py --title` (synchrone) sur `SessionStart` et
`UserPromptSubmit`, et la variable `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` dans `env`. Tous en `async: true`, sauf `SessionEnd` côté WSL, synchrone : un hook en
arrière-plan pourrait être tué avec la session avant d'avoir envoyé, et `notify.py` rend la
main en moins de 100 ms (mesuré, app arrêtée).

| Côté | Réglages | Fichiers | Commande |
| --- | --- | --- | --- |
| WSL | `~/.claude/settings.json` | `~/.claude/reverse-prompt/` | `python3 <…>/notify.py` |
| Windows | `%USERPROFILE%\.claude\settings.json` | `%USERPROFILE%\.claude\reverse-prompt\` | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<…>/notify.ps1"` |

`endpoint.json` (port et jeton de l'app, copiés à l'installation) accompagne chaque script.
Si le jeton de l'app change (fichier `token` supprimé), relancer l'installation.

```bash
npm run claude:install      # installe ou met à jour, des deux côtés
npm run claude:uninstall    # retire hooks et fichiers
python3 adapters/claude/install.py --dry-run   # montre sans écrire
```

L'installation fusionne : nos gestionnaires se reconnaissent à `reverse-prompt/notify` dans
leur commande, sont retirés puis remis ; tout le reste du fichier est conservé. Copie
horodatée (`settings.json.reverse-prompt-<date>.bak`) avant toute écriture, aucune si rien ne
change. Un `settings.json` illisible n'est jamais réécrit. Pertes possibles à la
désinstallation : une liste d'événement **vide** qui existait avant (`"Stop": []`) disparaît —
sans effet sur Claude ; `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` est retirée même si elle avait
été posée à la main.

### Limites connues

- La distinction CLI / Desktop repose sur des variables non documentées (section 1).
- `notify.ps1` démarre PowerShell (~0,3 à 0,5 s) : la notification d'une session Desktop arrive
  un peu plus tard que celle du CLI. Sans conséquence pour Claude (hook en arrière-plan).
- Retour à l'onglet précis : Windows Terminal seulement, sessions CLI WSL lancées après
  l'installation. Terminal de VS Code, CLI Windows et Claude Desktop : la fenêtre seulement.
- Titre de session généré par l'adaptateur (section 2) : absent tant que la session n'a reçu
  qu'un message (posé au message suivant seulement) ; un appel `claude -p` léger par génération,
  sur le compte de Victor ; non fait pour les sessions Desktop dans WSL ni le CLI Windows.
- `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` n'est pas documentée : si une version de Claude Code
  l'abandonne, Claude réécrira son titre, la marque disparaîtra de l'onglet et l'app retombera
  sur la fenêtre (« onglet introuvable » au journal).
