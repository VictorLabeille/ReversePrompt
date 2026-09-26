# AGENTS.md — ReversePrompt

Notification « Dynamic Island » pour agents de code (Claude Code WSL, Claude Desktop, puis
d'autres). Ce fichier oriente ; la documentation vit dans `README.md` et `docs/`.

## À lire en premier
1. Note Obsidian du projet : `Projets/ReversePrompt.md` du vault, puis sa jumelle
   `_agents/Projets/ReversePrompt.md` — arbitrages de Victor et état. Les tenir à jour selon les
   règles du vault (un agent n'écrit qu'une ligne de journal dans la note humaine).
2. `docs/animation.md` avant de toucher à l'animation.
3. `docs/spec-v0.1.md` : **pas un cahier des charges**. Ne pas appliquer une de ses valeurs ou
   de ses choix sans vérifier qu'il n'a pas été tranché autrement.

## Carte
| Chemin | Contenu |
| --- | --- |
| `src/island.ts` | machine à états, chorégraphies, rendu du contenu |
| `src/config/animation.ts` | **toutes** les valeurs d'animation |
| `src/anim/` | horloge virtuelle, canaux (ressorts analytiques), courbes |
| `src/blob/` | shader SDF WebGL2 et son rendu |
| `src/icons/` | icône par outil ; `icons/brand/` (marques Anthropic) est **hors dépôt** |
| `src/theme/` | variables CSS d'un thème |
| `src/main.ts`, `index.html` | page de l'overlay (future fenêtre Tauri) |
| `playground/` | page de réglage (`npm run playground`) |

## Règles
- Aucune valeur d'animation en dur hors de `src/config/animation.ts`. Une nouvelle clé garde un
  suffixe d'unité (`Ms`, `Px`, `Ratio`, `Scale`, `Speed`, `Hz`) : le playground en déduit les
  bornes de son curseur.
- Toute animation lit l'horloge virtuelle (`Clock`), jamais `performance.now()` ni `Date.now()`,
  sinon le ralenti et l'image par image du playground mentent.
- HTML : n'animer que `transform`, `opacity`, `filter`, `clip-path`. Fenêtre de taille fixe.
- Couleurs, police et ombre : uniquement via les variables CSS du thème.
- L'app doit rester indépendante de l'outil : rien de propre à Claude Code en dehors d'un futur
  adaptateur. Chaque adaptateur sera documenté dans `docs/` pour les agents suivants.
- Dépôt **public** : ni secret, ni jeton, ni donnée d'appareil, **ni logo ou icône d'Anthropic**
  (décision de Victor) — ceux-là vivent dans `src/icons/brand/`, ignoré par git.
- **Source de vérité unique : ce dépôt, dans WSL.** L'app Windows (Tauri) se compile côté Windows
  depuis un **miroir sur disque NTFS** synchronisé par script, jamais en travaillant dans un second
  clone Windows ni en compilant directement sur `\\wsl.localhost`.
- **Hooks WSL → app : `curl.exe` (Windows) détaché, vers `127.0.0.1`.** Jamais d'appel synchrone :
  si l'app est arrêtée, `curl.exe` met ~1,3 s à échouer. Code de sortie toujours 0. WSL est en
  réseau NAT : le `curl` Linux n'atteint pas le `127.0.0.1` de Windows.
- Prose et commentaires en français ; identifiants en anglais.

## Pièges d'outillage
- Pas de `cargo` dans WSL : la partie Tauri (Rust) se compilera côté Windows.
- Le playground se sert depuis WSL mais se juge dans un navigateur Windows (police Segoe UI
  Variable, écran 120 Hz). Un navigateur headless (SwiftShader) sert à capturer des images, pas
  à mesurer la fluidité.
- Vite 8 : `build.rolldownOptions` (et non plus `rollupOptions`).
- Vite 8 en dev sert **vide** une feuille CSS liée par `<link>` dans une page HTML : importer le
  CSS depuis le script (`import './x.css'`), jamais par `<link>`.
- `src/icons/brand/` est ignoré par git et ne doit jamais être versionné. Ne jamais importer ces
  fichiers directement : ils passent par `import.meta.glob` dans `icons/icon.ts`, sinon un clone du
  dépôt ne compile plus.
- `~/.claude/settings.json` (WSL) contient déjà des hooks : toute installation de hook **fusionne**,
  n'écrase jamais.
