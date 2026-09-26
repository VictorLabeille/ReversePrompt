# ReversePrompt

Une notification globale façon « Dynamic Island » pour prévenir quand un agent de code a besoin
de moi : de l'encre sort de l'encoche de l'écran, se rassemble en goutte, tombe et devient une
pilule où le message se tape, visible même par-dessus une vidéo en plein écran. Un clic ramène
la fenêtre de l'agent.

**Cibles de la v1 :** Claude Code en ligne de commande dans WSL, et Claude Desktop (sessions
Code et conversations). L'app doit rester indépendante de l'outil : d'autres agents (Codex,
OpenCode…) s'y brancheront par un adaptateur.

## État

- ✅ Playground d'animation : forme liquide en WebGL2, chorégraphie complète (entrée, sortie,
  relance, rappel), texte tapé, icône par outil, réglages en direct.
- ✅ App Windows (Tauri 2) : fenêtre overlay jamais activable, clics traversants hors de la
  pilule, serveur local, retour à la fenêtre de l'agent, zone de notification, lancement au
  démarrage.
- ✅ Contrat d'événement neutre, adaptateurs Claude Code (WSL) et Claude Desktop (onglet Code).
- ⏳ Recette à la main (`docs/acceptance.md`) ; conversations chat de Claude Desktop : aucun
  mécanisme propre, en attente d'une décision.

## Architecture

```
Hook d'un outil ──(adaptateur : traduit vers le contrat)──▶ curl.exe / PowerShell
      ──POST 127.0.0.1:47625/event──▶ app Tauri (Rust) ──▶ île (TypeScript, WebGL2)
                                           ◀── clic : ramène la fenêtre de l'agent
```

L'app ne connaît aucun outil : elle n'accepte que le contrat de `docs/event-contract.md`.
Chaque outil a son adaptateur (`adapters/`), qui traduit ses propres signaux.

## Installer (Windows + WSL)

```bash
npm install
npm run win:install      # compile côté Windows, installe l'app, la lance au démarrage
# lancer ReversePrompt une première fois (menu Démarrer), puis :
npm run claude:install   # hooks de Claude Code (WSL) et de Claude Desktop (Windows)
```

`npm run claude:uninstall` retire les hooks ; l'app se désinstalle depuis les paramètres de
Windows.

## Lancer le playground

```bash
npm run playground
```

Ouvrir ensuite `http://127.0.0.1:5173/playground/` dans un navigateur **Windows** (ou menu de
l'icône de l'app → « Ouvrir le playground »).
Raccourcis : `D` terminé, `N` besoin de toi, `R` rejouer l'entrée, `E` sortie, `Espace` pause,
`→` image suivante.

## Icônes et marques

Claude, Claude Code et leurs logos sont des marques d'Anthropic ; ce projet n'est ni affilié à
Anthropic ni approuvé par elle. Les icônes qui reprennent ces marques ne sont pas versionnées :
sans elles, l'île affiche une icône neutre.

## Documentation

- `docs/event-contract.md` — le contrat d'événement, et comment écrire un adaptateur.
- `docs/adapters/claude.md` — faits vérifiés sur les hooks de Claude, et l'adaptateur.
- `docs/app.md` — l'app Windows : fenêtre, clics traversants, fichiers, débogage.
- `docs/windows-focus.md` — ramener la fenêtre d'un agent malgré le verrou de Windows.
- `docs/animation.md` — comment la forme est dessinée et animée, et ce que pilote chaque réglage.
- `docs/acceptance.md` — la recette à la main.
- `docs/spec-v0.1.md` — la spec d'origine (recommandations, pas un cahier des charges).
