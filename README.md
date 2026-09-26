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
- ⏳ App Windows (Tauri 2) : fenêtre overlay, serveur local, mise au premier plan de l'agent.
- ⏳ Contrat d'événement neutre et adaptateurs (Claude Code, Claude Desktop).

## Lancer le playground

```bash
npm install
npm run playground
```

Ouvrir ensuite `http://127.0.0.1:5173/playground/` dans un navigateur **Windows**.
Raccourcis : `D` terminé, `N` besoin de toi, `R` rejouer l'entrée, `E` sortie, `Espace` pause,
`→` image suivante.

## Icônes et marques

Claude, Claude Code et leurs logos sont des marques d'Anthropic ; ce projet n'est ni affilié à
Anthropic ni approuvé par elle. Les icônes qui reprennent ces marques ne sont pas versionnées :
sans elles, l'île affiche une icône neutre.

## Documentation

- `docs/animation.md` — comment la forme est dessinée et animée, et ce que pilote chaque réglage.
- `docs/spec-v0.1.md` — la spec d'origine (recommandations, pas un cahier des charges).
