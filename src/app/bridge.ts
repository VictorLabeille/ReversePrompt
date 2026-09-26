// Pont entre l'île et l'app Tauri : reçoit les événements du contrat (déjà validés par l'app),
// renvoie les clics et l'état de l'île. Rien ici ne connaît un outil en particulier.
//
// Clics traversants : la fenêtre laisse passer tous les clics, sauf quand le curseur est sur
// la pilule. L'app envoie la position du curseur (elle seule la connaît quand la fenêtre est
// traversée) ; l'île répond par son hitTest, à chaque image, car la pilule bouge sous un
// curseur immobile.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AnimationConfig } from '../config/animation';
import type { Island, IslandState, Source } from '../island';
import type { NoticeKind } from '../messages';

interface ShowPayload {
  kind: 'done' | 'needs-input';
  source: Source;
  text: string | null;
}

const KINDS: Record<ShowPayload['kind'], NoticeKind> = { done: 'done', 'needs-input': 'needs' };

export class Bridge {
  private cursor: [number, number] | null = null;
  private interactive = false;
  private hovered = false;

  constructor(private readonly island: Island) {}

  async connect(cfg: AnimationConfig): Promise<void> {
    await listen<ShowPayload>('island://show', ({ payload }) => {
      this.island.show(KINDS[payload.kind], { source: payload.source, text: payload.text ?? undefined });
    });
    await listen('island://dismiss', () => this.island.dismiss('external'));
    await listen<[number, number]>('island://cursor', ({ payload }) => {
      this.cursor = payload;
      this.updateHit();
    });

    // Quand la fenêtre capte les clics, le navigateur donne directement la position.
    window.addEventListener('mousemove', (e) => {
      this.cursor = [e.clientX, e.clientY];
      this.updateHit();
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousedown', (e) => {
      if (!this.island.hitTest(e.clientX, e.clientY)) return;
      if (e.button === 0) {
        void invoke('activate');
        this.island.dismiss('click');
      } else if (e.button === 2) {
        void invoke('close');
        this.island.dismiss('close');
      }
    });

    await invoke('overlay_ready', { widthPx: cfg.window.widthPx, heightPx: cfg.window.heightPx });
  }

  // À appeler à chaque image et à chaque changement d'état de l'île.
  updateHit(): void {
    const hit = this.cursor !== null && this.island.hitTest(...this.cursor);
    if (hit !== this.interactive) {
      this.interactive = hit;
      void invoke('set_interactive', { on: hit });
    }
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.island.hover(hit);
    }
  }

  stateChanged(state: IslandState): void {
    void invoke('island_state', { state });
    this.updateHit();
  }
}
