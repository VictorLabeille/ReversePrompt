// Icône affichée à gauche du texte, choisie selon l'outil qui a émis l'événement.
// Chaque icône anime elle-même son contenu à partir du temps virtuel (voir anim/clock.ts).

import type { NoticeKind } from '../messages';
import { DropIcon } from './drop';

// Outil à l'origine de la notification. Un nouvel outil ajoute sa valeur ici et, s'il a une
// icône propre, un module dans icons/ ou icons/brand/.
export type Source = 'claude-code' | 'claude-desktop' | 'generic';

export interface Icon {
  readonly element: SVGSVGElement;
  setMood(mood: NoticeKind, t: number): void;
  update(t: number): void;
}

export interface IconModule {
  source: Source;
  default: (sizePx: number) => Icon;
}

// Les icônes de marque sont facultatives : absentes d'un clone du dépôt (voir .gitignore),
// elles sont remplacées par l'icône neutre.
const brandModules = Object.values(import.meta.glob<IconModule>('./brand/*.ts', { eager: true }));

export function createIcon(source: Source, sizePx: number): Icon {
  const module = brandModules.find((m) => m.source === source);
  return module ? module.default(sizePx) : new DropIcon(sizePx);
}
