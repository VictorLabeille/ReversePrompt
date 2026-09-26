# Ramener la fenêtre d'un agent au premier plan (Windows)

Code : `src-tauri/src/focus.rs`. Appelé au clic gauche sur l'île (commande `activate`), avec la
cible `focus` du dernier événement (`docs/event-contract.md`).

## Trouver la fenêtre

1. `EnumWindows` parcourt les fenêtres de haut niveau **dans l'ordre Z** : la première trouvée
   est la plus récemment active.
2. On garde les fenêtres d'application : visibles (une fenêtre réduite l'est aussi), sans
   propriétaire, sans `WS_EX_TOOLWINDOW`, avec un titre.
3. On compare le nom de l'exécutable du processus propriétaire (`QueryFullProcessImageNameW`)
   à `focus.process`, sans tenir compte de la casse.
4. Si `focus.title` est donné, la première dont le titre le contient gagne ; sinon, la plus
   récente.

Windows Terminal : toutes ses fenêtres appartiennent à `WindowsTerminal.exe` ; on ramène la
fenêtre, pas l'onglet. Claude Desktop : `claude.exe`.

## La ramener malgré le verrou de premier plan

Windows n'accepte `SetForegroundWindow` que d'un processus qui a reçu la dernière entrée de
l'utilisateur (entre autres conditions). Or le clic sur l'île est reçu par la fenêtre de
WebView2, qui appartient au processus `msedgewebview2.exe`, pas à l'app. D'où trois tentatives,
chacune vérifiée par `GetForegroundWindow` ; la méthode qui a réussi est écrite au journal
(`clic : <programme> → <méthode>`) :

| Ordre | Méthode | Effet de bord |
| --- | --- | --- |
| 1 | `SetForegroundWindow` directe (après `SW_RESTORE` si la fenêtre est réduite) | aucun |
| 2 | `SendInput` d'une entrée souris vide, puis `SetForegroundWindow` : le processus devient celui de la dernière entrée (méthode de PowerToys) | aucun ; pas de touche Alt simulée, qui ouvrirait le menu de certaines apps |
| 3 | `AttachThreadInput` sur le fil du premier plan actuel, `BringWindowToTop`, `SetForegroundWindow`, puis détachement | partage momentané de l'état clavier |

Vérifié le 2026-09-26 (Windows 11 26200) : fenêtre cible réduite derrière Windows Terminal →
restaurée et au premier plan, méthode 1, déclenchée sans clic réel. **Non vérifié** : un vrai
clic de souris sur l'île, une vidéo plein écran, un autre bureau virtuel (`docs/acceptance.md`).

## L'île ne doit jamais voler le focus

- Fenêtre `WS_EX_NOACTIVATE`, affichée par `SW_SHOWNOACTIVATE`, remontée par
  `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)`. Vérifié : l'apparition de l'île laisse le
  premier plan à la fenêtre active.
- Clic droit : ne fait rien d'autre qu'oublier la cible et faire sortir l'île.

## Départ de l'île quand l'agent revient au premier plan

Un abonnement `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` (fil dédié avec sa boucle de messages)
reçoit chaque changement de premier plan. Si la nouvelle fenêtre appartient à
`focus.process` **et** que l'utilisateur a touché clavier ou souris dans les 1,5 s
(`GetLastInputInfo`), l'île part.

Sans la seconde condition, l'île partait toute seule : quand une notification Windows se ferme,
ou au verrouillage de la session, Windows rend le premier plan à la fenêtre d'avant — souvent
le terminal — sans action de l'utilisateur (observé le 2026-09-26).
