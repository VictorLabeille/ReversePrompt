# Contrat d'événement — v1

L'app ReversePrompt ne connaît **aucun outil**. Elle reçoit des événements dans le format
ci-dessous, et rien d'autre. Chaque outil (Claude Code, Claude Desktop, demain Codex ou
OpenCode…) a un **adaptateur** qui traduit ses propres signaux vers ce format, en dehors de
l'app (voir `docs/adapters/`). Le JSON brut d'un outil n'entre jamais dans l'app.

Ce contrat est **figé** pour la v1 (décision déléguée à l'agent, 2026-09-26). Toute évolution
suit la règle de compatibilité en fin de document.

## Transport

| | |
| --- | --- |
| Adresse | `http://127.0.0.1:<port>/event` — l'app n'écoute **que** sur `127.0.0.1` |
| Port | `47625` par défaut, réglable dans `config.json` (voir « Fichiers de l'app ») |
| Méthode | `POST` |
| En-têtes | `Content-Type: application/json` ; `X-ReversePrompt-Token: <jeton>` |
| Corps | un objet JSON, **4 Kio au plus**, UTF-8 |

Réponses :

| Code | Sens |
| --- | --- |
| `204` | accepté. **Renvoyé aussi** quand l'événement est ignoré (doublon, pause, `dismiss` d'une autre session) : l'émetteur n'a rien à en faire |
| `400` | JSON illisible ou champ invalide ; le corps de la réponse dit lequel, en texte |
| `401` | jeton absent ou faux |
| `404` / `405` | autre chemin / autre méthode |
| `413` | corps de plus de 4 Kio |

`GET /health` répond `200` avec `reverse-prompt 1` (nom et version du contrat), sans jeton :
il sert aux scripts d'installation à vérifier que l'app tourne.

La réponse part **avant** tout traitement : l'app répond, puis transmet l'événement à l'île.

**Un émetteur ne doit jamais attendre l'app.** Il envoie en arrière-plan, avec un délai court,
et ignore toute erreur : app arrêtée, l'outil doit continuer comme si de rien n'était.

## Corps

```json
{
  "v": 1,
  "source": "claude-code",
  "kind": "needs-input",
  "session": "5f0c2d1e-…",
  "focus": { "process": "WindowsTerminal.exe", "title": "mon-projet" },
  "text": "Une validation ?"
}
```

| Champ | Type | Oblig. | Règle |
| --- | --- | --- | --- |
| `v` | entier | oui | version du contrat ; `1` |
| `source` | chaîne | oui | identifiant de l'outil, `[a-z0-9][a-z0-9-]{0,31}`. Choisit l'icône ; un outil sans icône a l'icône neutre |
| `kind` | chaîne | oui | `done` (l'agent a fini), `needs-input` (l'agent attend une réponse ou une autorisation), `dismiss` (l'utilisateur a repris la main : l'île doit partir) |
| `session` | chaîne | oui | identifiant opaque de la session de l'outil, 1 à 128 caractères. Sert au dédoublonnage et au `dismiss` |
| `focus` | objet | non | la fenêtre à ramener au clic. Absent : le clic ferme l'île sans changer de fenêtre |
| `focus.process` | chaîne | oui dans `focus` | nom de l'exécutable qui possède la fenêtre, `*.exe`, 64 caractères au plus, casse ignorée (`WindowsTerminal.exe`, `claude.exe`, `Code.exe`…) |
| `focus.title` | chaîne | non | fragment du titre de fenêtre **ou d'onglet**, 128 caractères au plus, casse ignorée : départage plusieurs fenêtres, ou plusieurs onglets, du même programme. L'émetteur doit s'assurer que ce fragment désigne un seul onglet (l'adaptateur Claude pose lui-même un titre unique) |
| `text` | chaîne | non | texte de la pilule. Tronqué à 32 caractères (avec `…`) ; absent ou vide : un texte tiré au hasard dans `src/messages.json` selon `kind` |

Les champs inconnus sont **ignorés** : un émetteur peut en ajouter sans casser un serveur plus
ancien. Un champ connu mais de mauvais type ou hors limites donne `400`.

`needs-input` et `done` font apparaître l'île ; `dismiss` la fait partir.

Dans Windows Terminal, le titre de la fenêtre est celui de l'onglet actif : une cible avec
`focus.title` désigne donc un onglet, et « la cible est au premier plan » veut dire « sa
fenêtre est au premier plan **et** son onglet est l'onglet actif ».

## Règles de l'app

1. **Le dernier gagne.** L'île montre un seul événement à la fois : celui reçu en dernier,
   quelle que soit sa session. Sa `session`, sa `source` et son `focus` deviennent la cible
   courante du clic.
2. **Mise à jour sans relance.** Si l'île est déjà là, un nouvel événement ne rejoue pas la
   chute : petite secousse, et le texte se retape s'il change (comportement de l'île, voir
   `docs/animation.md`, « pulse »).
3. **Dédoublonnage.** Un événement de même `session`, même `kind` et même `text` qu'un
   événement reçu il y a moins de **2 s** est ignoré (hook déclaré deux fois, relances).
4. **`dismiss` ne concerne que sa session.** Il ne fait partir l'île que si elle montre un
   événement de la même `session`. Répondre dans un terminal n'efface pas la notification
   d'un autre.
5. **Pause.** Pendant une pause (menu de la zone de notification), les événements `done` et
   `needs-input` sont ignorés ; `dismiss` reste appliqué.
6. **Déjà sur la cible.** Un `done` ou `needs-input` dont la cible a un `focus.title` et est
   déjà au premier plan à son arrivée est ignoré : l'utilisateur regarde déjà l'onglet.
   Sans `focus.title`, l'île apparaît toujours (on ne sait pas quel onglet est le bon).
7. **Clic gauche** : ramène la fenêtre `focus` (restaurée si réduite) ; si aucune fenêtre ne
   porte le titre `focus.title` mais qu'un de ses **onglets** le porte, cet onglet est
   sélectionné d'abord. Puis l'île part.
   **Clic droit** : l'île part, la fenêtre active ne change pas. Dans les deux cas la cible
   courante est oubliée.
8. **Retour par un autre chemin** : quand la cible passe au premier plan (Alt+Tab, barre des
   tâches, changement d'onglet), l'île part d'elle-même. Si la cible y était déjà, un clic
   dedans la fait partir.

## Fichiers de l'app

Dossier de données : `%APPDATA%\io.github.victorlabeille.reverseprompt\`.

| Fichier | Contenu |
| --- | --- |
| `token` | le jeton, 64 caractères hexadécimaux, créé au premier lancement. Le supprimer en fait créer un nouveau au lancement suivant (il faut alors relancer l'installation des adaptateurs) |
| `config.json` | `{ "port": 47625 }`, créé au premier lancement ; lu au démarrage |

Un adaptateur lit ces deux fichiers **à l'installation** et en garde une copie de son côté.

Modèle de menace : empêcher un autre programme local, ou une page web, de déclencher de fausses
notifications. Une page web ne peut pas poser l'en-tête `X-ReversePrompt-Token` sans requête
de pré-vérification CORS, que l'app refuse. Le jeton n'est **pas** un secret face à un
programme qui tourne sous le même compte Windows : il peut lire le fichier.

## Compatibilité

- Un serveur qui gère la version N accepte toutes les versions de 1 à N.
- Ajouter un champ **facultatif** ou une valeur de `kind` n'exige pas de nouvelle version si
  l'ignorer reste sans danger. Un serveur v1 répond `400` à un `kind` qu'il ne connaît pas ;
  l'émetteur l'ignore, comme toute erreur.
- Changer le sens ou le type d'un champ existant exige `v: 2`.

## Écrire un adaptateur

1. Relever les signaux de l'outil **dans sa documentation officielle** et les consigner dans
   `docs/adapters/<outil>.md` (modèle : `docs/adapters/claude.md`).
2. Choisir `source` et, si l'outil a une icône, l'ajouter (`src/icons/`, voir
   `docs/animation.md`, « Icônes »).
3. Traduire chaque signal en `done`, `needs-input` ou `dismiss` ; en ignorer plutôt que
   d'en inventer.
4. Envoyer sans jamais bloquer l'outil (processus détaché, délai d'une seconde, sortie 0).
5. Fournir installation (fusion, relançable, sauvegarde) et désinstallation.
