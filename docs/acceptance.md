# Recette de la v1 — ce que seul Victor peut vérifier

Tout ce qui se vérifie sans écran ni sensation est couvert par des tests automatiques
(liste en fin de document). Restent ces essais, à faire sur le Yoga Pro 7i, app installée.
En cas d'échec, le journal `%APPDATA%\io.github.victorlabeille.reverseprompt\reverse-prompt.log`
dit ce que l'app a reçu et fait.

## À la main

1. **Claude Code dans WSL** — lancer une tâche, changer de fenêtre : à la fin, l'île tombe
   (moins de 300 ms ressentis). Demande d'autorisation laissée ~6 s sans taper : l'île
   « besoin de toi ». Répondre dans le terminal : elle part.
2. **Clic gauche** : Windows Terminal revient au premier plan quand il est **réduit** et
   **derrière une vidéo plein écran** (le cas simple est confirmé). **Clic droit** : l'île part, la fenêtre active ne change pas.
3. **Vidéo YouTube plein écran** : l'île passe au-dessus, la vidéo reste en plein écran et
   réagit toujours au clavier (Espace, flèches).
4. **Clics traversants** : île cachée, les onglets du navigateur sous l'encoche restent
   cliquables ; île visible, seul un clic **sur** la pilule est capté (léger grossissement au
   survol ; le curseur reste une flèche).
5. **Alt+Tab vers le terminal** pendant que l'île est là : elle part d'elle-même. **Verrouiller
   puis déverrouiller** le PC : elle doit rester.
6. **Claude Desktop, onglet Code** (session Windows **et** session WSL) : fin de tâche →
   icône étoile ; clic → Claude Desktop revient. C'est ici que se confirme la détection
   CLI / Desktop, qui repose sur des variables non documentées (`docs/adapters/claude.md`).
7. **Fluidité à 120 Hz** : entrée et sortie sans à-coup, y compris la toute première
   notification après un redémarrage (préchauffage).
8. **Netteté** à 150 % et 200 % de mise à l'échelle (le poste est à 175 %) : bords de la
   pilule et texte nets. Changer l'échelle exige de relancer l'app (fenêtre dimensionnée au
   lancement).
9. **Autre bureau virtuel** : l'île apparaît sur le bureau courant ; le clic ramène le terminal
   situé sur un autre bureau.
10. **Démarrage de Windows** : l'app se lance seule (icône dans la zone de notification).
    Menu : notification de test, playground, pause 1 h, quitter.
11. **Sensation** générale : l'effet d'encre, la frappe, les textes.
12. **Onglets** (retours du 2026-09-28 ; ouvrir **de nouvelles** sessions Claude Code, les
    anciennes gardent le titre de Claude) — deux onglets Windows Terminal, chacun avec une
    session : leurs titres sont `<dossier> · <6 caractères>`, différents.
    - Tâche finie dans l'onglet A pendant qu'on est sur l'onglet B : l'île tombe ; clic → la
      fenêtre revient **sur l'onglet A**.
    - Même situation, passer soi-même sur l'onglet A (clic sur l'onglet, Ctrl+Tab) : l'île part.
    - Tâche finie dans l'onglet A pendant qu'on **regarde** l'onglet A : pas d'île du tout.
    - Onglet B au premier plan, île de A visible, clic **dans** l'onglet B : l'île reste.
13. **Clic dans le terminal déjà au premier plan** (session ouverte avant l'installation, donc
    sans titre à nous) : l'île est là, clic dans le terminal → elle part.

## Déjà vérifié automatiquement ou par l'agent (2026-09-26)

- Contrat : validation du JSON, jeton, codes HTTP, règles du cœur — `npm run win:test`
  (17 tests Rust depuis le 2026-09-28).
- Adaptateur : 25 cas de traduction identiques pour `notify.py` et `notify.ps1` ; fusion des
  réglages idempotente, sauvegarde, désinstallation qui rend l'original, fichier illisible
  jamais écrasé ; hook app arrêtée : sortie 0 en moins de 100 ms — `npm run test:adapters`.
- App réelle : latence hook → app 59 à 82 ms ; l'apparition de l'île ne prend pas le focus ;
  fenêtre réduite restaurée et ramenée au premier plan ; survol qui tient et clic qui ramène
  le terminal (confirmés par Victor) ; rendu
  de l'île capturé dans WebView2 à 175 % et sur l'écran réel ; processeur ~0,2 % d'un cœur au
  repos ; lancement au démarrage inscrit.
- **Écart connu** : mémoire totale ~181 Mo (dont 87 Mo pour le processus GPU de WebView2),
  au-dessus des 100 Mo indicatifs de la spec.
