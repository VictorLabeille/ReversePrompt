# Animation de l'île — fonctionnement

Ce document décrit comment l'île est dessinée et animée. Il sert à quiconque (humain ou agent)
doit régler, étendre ou déboguer l'animation. Les valeurs elles-mêmes vivent dans
`src/config/animation.ts` ; ce document explique ce qu'elles pilotent.

## L'effet voulu

Arrêté par Victor le 2026-09-26, après un premier essai du playground :

1. **Un film d'encre** apparaît sous toute la largeur de l'encoche de l'écran (sur le Yoga Pro 7i :
   la bosse de webcam au-dessus de la dalle, large et parfaitement centrée).
2. **L'encre se rassemble** au centre et forme une goutte qui pend, s'alourdit ; le col s'amincit.
3. **La goutte tombe. Le fil casse pendant la chute** et remonte dans l'encoche.
4. La goutte **atterrit** (rebond, étalement) en une petite pilule juste assez large pour l'icône.
5. L'icône apparaît, puis **le texte se tape lettre à lettre**, avec un curseur, et la pilule
   s'allonge avec lui.
6. **Sortie** : le contenu s'efface, la pilule se rétracte en goutte et **disparaît sur place**.

Lectures écartées en chemin : pilule restant suspendue à son fil (premier essai) ; fil cassant
après l'étalement ; remontée dans l'encoche à la sortie ; pilule déjà à sa largeur finale pendant
la frappe.

## Rendu de la forme (`src/blob/`)

Toute la forme noire est **un seul shader WebGL2** (`shader.ts`) qui évalue un champ de distance
signé (SDF) par pixel, en pixels logiques. Quatre primitives, fusionnées par minimum lisse
(`smin`) pour obtenir des raccords liquides :

| Primitive | Forme | Rôle |
| --- | --- | --- |
| Bord | demi-plan juste au-dessus de la fenêtre (`shape.edgeOffsetPx`) | fait naître un ménisque là où l'encre touche le bord |
| Bosse (`lip`) | ellipse centrée sur le bord | le film d'encre sous l'encoche, puis le rassemblement |
| Fil | capsule effilée du bord à sa pointe | le col de la goutte ; après la casse, sa pointe remonte vers le bord |
| Tête | rectangle à coins de rayon maximal | cercle (goutte) quand ses deux demi-dimensions sont égales, pilule quand elle s'élargit |

- La pointe du fil vaut « la tête » tant qu'il tient (`min(pointe, y de la tête)`). À la casse,
  elle se détache et remonte : c'est l'écart entre les deux qui produit le pincement liquide.
- `shape.edgeSmoothPx` règle la douceur des raccords au bord, `shape.headSmoothPx` celle du
  raccord fil ↔ tête.
- L'anti-crénelage vient directement de la distance : couverture = `0,5 − d × dpr`. Le rendu
  reste net à toute mise à l'échelle Windows.
- L'ombre portée ne concerne que la tête, et s'efface quand la tête est une goutte.
- Couleurs, ombre et police viennent des variables CSS du thème (`src/theme/black.css`), lues
  par `Island.refreshTheme()`. Un nouveau thème redéfinit ces variables sans toucher au code.

Le contenu (icône, texte, curseur) est en HTML **au-dessus** du canevas. Il suit le centre de la
tête, et il est découpé par un `clip-path` à la forme courante de la pilule : rien ne déborde
pendant que la pilule s'élargit.

## Moteur d'animation (`src/anim/`)

- **Horloge virtuelle** (`clock.ts`) : toute l'animation lit ce temps, jamais l'horloge réelle.
  C'est ce qui permet au playground le ralenti, la pause et l'avance image par image.
- **Canaux** (`channel.ts`) : chaque grandeur animée (position de la tête, largeur, pointe du fil,
  opacité de l'icône…) est une suite de segments datés : valeur fixe, interpolation, ressort. La
  valeur est une **fonction pure du temps**.
  - Changer de cible repart de la valeur **et de la vitesse** courantes : aucune interruption ne
    produit de saut.
  - Planifier un segment annule ceux qui étaient prévus après lui.
  - Les ressorts sont résolus **analytiquement** (oscillateur amorti, masse 1). Le résultat ne
    dépend pas de la fréquence d'images.
- **Étirement** (squash & stretch) : calculé à partir de la vitesse verticale de la tête
  (`drop.stretchPerSpeed`, plafonné par `drop.maxStretch`), plein sur la goutte, atténué sur la
  pilule (`drop.pillStretchRatio`).

La spec v0.1 proposait la bibliothèque Motion pour les ressorts. Elle n'est pas utilisée : il
fallait une horloge virtuelle partagée et des courbes lisibles à n'importe quel instant, deux
choses qu'un moteur maison d'une centaine de lignes donne directement.

## Chorégraphie (`src/island.ts`)

Machine à états : `hidden → entering → shown → exiting → hidden`.

**Entrée** (`scheduleEntry`), à partir de l'instant T :

| Phase | Durée | Ce qui bouge |
| --- | --- | --- |
| Film | `entry.filmMs` | la bosse s'étend à `notch.widthPx`, épaisse de `notch.filmHeightPx` |
| Rassemblement | `entry.gatherMs` | la bosse se resserre (`notch.gatherHalfWidthPx`, `notch.gatherHeightPx`) ; à mi-course, la goutte en sort |
| Suspension | `entry.hangMs` | la goutte s'alourdit (`drop.hangRadiusPx`) et s'affaisse (`drop.sagYPx`) ; le col s'amincit |
| Chute | `entry.fallMs` | chute accélérée jusqu'à `pill.centerYPx` ; à `entry.breakRatio` de la chute, le fil casse et remonte en `thread.retractMs` ; la bosse est réabsorbée |
| Atterrissage | ressorts | la tête garde sa vitesse et rebondit (`entry.bounce`) ; elle s'étale (`entry.spread`) à la largeur de l'icône seule |
| Contenu | dès que la pilule atteint `entry.contentStartRatio` de cette largeur | icône (échelle `content.iconScaleFrom` → 1), puis frappe après `typing.startDelayMs` |

**Frappe** (`scheduleTyping`) : une lettre toutes les `typing.charMs`. Les largeurs de la pilule
pour chaque préfixe du texte sont mesurées d'avance ; à chaque lettre, la largeur repart par
ressort (`typing.widthSpring`) vers la suivante, **plus `typing.leadPx`** (sans dépasser la
largeur finale) : la pilule s'ouvre devant le texte. Sans cette avance, le ressort suit le texte
de trop près et le texte semble sortir de la pilule (retour de Victor, 2026-09-26). Le curseur est plein pendant la frappe, puis
clignote (`typing.caretBlinkMs`) pendant `typing.caretLingerMs`.

**Sortie** (`scheduleExit`) : le contenu s'efface (`exit.contentFadeMs`), la pilule se rétracte
en goutte (`exit.shrink`, `exit.dropRadiusPx`), puis la goutte se résorbe sur place
(`exit.vanishMs`). Un clic ajoute d'abord un enfoncement (`interaction.pressScale`).

**Événement quand l'île est déjà là** (`pulse`) : petite secousse (`pulse.kickSpeed`) ; si le
texte change, la pilule revient à la largeur de l'icône et le nouveau texte se tape.
**Pendant la sortie** (`recover`) : la goutte se regonfle en pilule depuis son état courant et
le texte se tape. **Rappel** : secousse plus douce tous les `reminder.intervalMs`.

## Icônes (`src/icons/`)

L'icône dépend de l'outil qui a émis l'événement (`Source` dans `icons/icon.ts`) :

| Source | Icône | Fichier |
| --- | --- | --- |
| `claude-code` | personnage de Claude Code, en pixels | `icons/brand/claude-code.ts` |
| `claude-desktop` | étoile de Claude | `icons/brand/claude.ts` |
| `generic` (et tout outil sans icône) | goutte blanche neutre | `icons/drop.ts` |

Chaque icône implémente `Icon` : elle s'anime elle-même à partir du temps virtuel, avec deux
humeurs (`done` calme, `needs` agitée). Les icônes de `icons/brand/` reprennent des **marques
d'Anthropic** : elles sont **ignorées par git** (voir `.gitignore`) et chargées si elles sont
présentes. Sur un clone du dépôt, toutes les sources retombent sur l'icône neutre.

Ajouter l'icône d'un nouvel outil : ajouter sa valeur à `Source`, puis un module qui exporte
`source` et une fabrique par défaut (modèle : `icons/brand/claude.ts`).

## Règles de performance

- La fenêtre a une taille fixe (`window.*`) ; rien ne la redimensionne ni ne la déplace pendant
  une animation.
- Côté HTML, seuls `transform`, `opacity` et `clip-path` sont animés ; le texte change par son
  contenu, une lettre à la fois.
- Une seule boucle `requestAnimationFrame`, arrêtée dès que l'île est cachée.
- `Island.warmup()` compile le shader, attend la police et joue une entrée invisible, pour que la
  première notification ne saccade pas.

## Écarts avec la spec v0.1

- L'encre part de l'encoche et converge, au lieu d'une simple bosse au centre.
- Le texte se tape, au lieu d'un fondu flou → net ; la pilule grandit avec lui.
- La pilule atterrit à `pill.centerYPx` = 58 px du haut, et non à 10 px : la goutte a besoin
  d'une hauteur de chute.
- Pas de bibliothèque Motion (voir « Moteur d'animation »).

## Le playground (`playground/`)

`npm run playground`, puis ouvrir `http://127.0.0.1:5173/playground/` **dans un navigateur
Windows** : la police Segoe UI Variable et l'écran à 120 Hz n'existent que là.

Le panneau montre d'abord **« Réglages essentiels »** : une dizaine de valeurs nommées en clair,
dans l'ordre où on les voit à l'écran (liste `ESSENTIALS` de `playground/main.ts`). Tout le reste
est dans **« Tous les réglages (avancé) »**, replié, généré depuis la config elle-même : une clé
ajoutée à la config y apparaît sans autre code. Les bornes de ces curseurs sont déduites du
**suffixe de la clé** (`Ms`, `Px`, `Ratio`, `Scale`, `Speed`, `stiffness`, `damping`) : garder ces
suffixes pour toute nouvelle clé. Un trait rose en haut marque l'encoche (`notch.widthPx`).
« Copier la config » produit un objet à coller à la place de celui de `src/config/animation.ts`.

Depuis la console du navigateur : `island`, `clock` et `animation` sont exposés
(`clock.paused = true; island.show('needs', { source: 'claude-desktop' }); clock.step(8); island.renderNow()`).
