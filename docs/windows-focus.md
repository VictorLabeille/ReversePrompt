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
4. Si `focus.title` est donné : la première fenêtre dont le titre le contient gagne (son
   onglet est déjà l'onglet actif) ; sinon, la première dont un **onglet** le contient, et cet
   onglet est sélectionné avant de ramener la fenêtre ; sinon, la plus récente, au journal
   « onglet introuvable ». Sans `focus.title`, la plus récente.

Windows Terminal : toutes ses fenêtres appartiennent à `WindowsTerminal.exe`, et le titre de
la fenêtre est celui de l'onglet actif. Claude Desktop : `claude.exe`.

### Onglets (UI Automation)

Relevé du 2026-09-28, Windows Terminal 1.24 : sous la fenêtre `CASCADIA_HOSTING_WINDOW_CLASS`,
chaque onglet est un élément `TabItem` dont le nom est le titre de l'onglet, avec
`SelectionItemPattern` (`IsSelected`, `Select()`). `focus::select_tab` parcourt tous les
descendants de la fenêtre et filtre sur le type `TabItem` (pas de condition à construire, donc
pas de `VARIANT`). COM est initialisé sur le fil du clic, le temps de l'appel.

Un titre ne distingue deux sessions que s'il est unique : Claude Code écrit le sien
(« Claude Code » pour toutes les sessions sans titre), d'où le titre posé par l'adaptateur
(`docs/adapters/claude.md`, « Titre de l'onglet »). Onglet coupé en volets : le titre est celui
du volet actif, un seul volet est donc reconnu à la fois.

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
restaurée et au premier plan (méthode 1, déclenchée sans clic réel). **Vrai clic de Victor** sur
l'île : la méthode 1 échoue, la **méthode 2** ramène Windows Terminal — le verrou joue bien, à
cause de WebView2. Non vérifié : vidéo plein écran, autre bureau virtuel (`docs/acceptance.md`).

## L'île ne doit jamais voler le focus

- Fenêtre `WS_EX_NOACTIVATE`, affichée par `SW_SHOWNOACTIVATE`, remontée par
  `SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE)`. Vérifié : l'apparition de l'île laisse le
  premier plan à la fenêtre active.
- Clic droit : ne fait rien d'autre qu'oublier la cible et faire sortir l'île.

## Départ de l'île quand l'agent revient au premier plan

Un fil dédié (avec sa boucle de messages) s'abonne à `EVENT_SYSTEM_FOREGROUND` (changement de
premier plan) et à `EVENT_OBJECT_NAMECHANGE` limité au titre de la fenêtre au premier plan
(`OBJID_WINDOW`) : changer d'onglet dans Windows Terminal change ce titre, pas le premier plan.
« La cible » est une fenêtre de `focus.process` dont le titre contient `focus.title` s'il est
donné. L'île part seulement si **toutes** ces conditions tiennent :

1. la fenêtre au premier plan est la cible ;
2. la fenêtre d'avant (programme et titre) **n'était pas** la cible. Le point de départ est
   relevé à l'apparition de l'île, puis suivi à chaque changement ; les événements de l'app et
   de WebView2 (`reverse-prompt.exe`, `msedgewebview2.exe`) ne comptent pas ;
3. la souris n'est pas sur la pilule (fenêtre captante) ;
4. l'utilisateur a touché clavier ou souris dans les 1,5 s (`GetLastInputInfo`) ;
5. aucun changement de bureau (`EVENT_SYSTEM_DESKTOPSWITCH` : verrouillage, déverrouillage)
   dans les 3 s.

Chacune corrige un départ intempestif observé le 2026-09-26 :

| Condition | Sans elle |
| --- | --- |
| 2 et 3 | survoler la pilule la rend captante ; Windows réémet alors « terminal au premier plan » alors qu'il l'était déjà, et l'île partait. Le point de départ relevé au lancement de l'app était en outre périmé (aucun changement vu depuis) |
| 4 | une notification Windows qui se ferme, ou le verrouillage, rend le premier plan au terminal sans action de l'utilisateur |
| 5 | au déverrouillage, le mot de passe tapé compte comme une entrée, et le terminal revient au premier plan : l'île partait au moment où l'utilisateur revenait la voir |

Chaque décision est écrite au journal avec le programme d'avant et d'après.

### Cible déjà au premier plan

- **À l'arrivée d'un événement** dont la cible a un `focus.title` : l'île n'apparaît pas
  (journal : « déjà sur la cible, ignoré »). Vérifié le 2026-09-28 avec l'onglet actif de
  Victor.
- **Pendant que l'île est là** (cible sans titre, ou onglet revenu par un autre chemin) :
  aucune transition possible, donc rien ne la ferait partir. Un crochet souris bas niveau
  (`WH_MOUSE_LL`, même fil) voit chaque appui de bouton ; si la fenêtre sous le curseur est
  la fenêtre au premier plan et qu'elle est la cible, l'île part (journal : « clic dans … »).
  Un clic dans une autre fenêtre change le premier plan et suit le chemin ci-dessus ; un clic
  sur la pilule tombe sur la fenêtre de l'île, jamais au premier plan. Le crochet ne fait
  qu'une lecture d'état tant que l'île est cachée : il retarde toute la souris du poste.
