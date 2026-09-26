// Canal d'animation : une valeur numérique décrite comme une suite de segments datés
// (constante, interpolation, ressort). La valeur est une fonction pure du temps : on peut
// la lire à n'importe quel instant, ce qui rend le ralenti, la lecture image par image et
// l'interruption d'une animation exacts et sans saut.
//
// Les temps sont en millisecondes « virtuelles » (voir clock.ts). Les ressorts sont résolus
// analytiquement (oscillateur harmonique amorti, masse 1) : aucune intégration numérique,
// donc aucun résultat qui dépendrait de la fréquence d'images.

import type { SpringConfig } from '../config/animation';
import type { Ease } from './ease';

type Segment =
  | { kind: 'set'; t0: number; x0: number }
  | { kind: 'tween'; t0: number; x0: number; to: number; durationMs: number; ease: Ease }
  | { kind: 'spring'; t0: number; x0: number; v0: number; to: number; spring: SpringConfig };

// Pas utilisé pour estimer une vitesse par différence finie, en ms.
const VELOCITY_STEP_MS = 0.5;

export class Channel {
  private segments: Segment[];

  constructor(initial = 0) {
    this.segments = [{ kind: 'set', t0: -Infinity, x0: initial }];
  }

  value(t: number): number {
    return evaluate(this.segmentAt(t), t);
  }

  // Vitesse en unités par seconde, estimée à l'intérieur du segment actif.
  velocity(t: number): number {
    const seg = this.segmentAt(t);
    const back = Math.max(seg.t0, t - VELOCITY_STEP_MS);
    const front = back === t ? t + VELOCITY_STEP_MS : t;
    return ((evaluate(seg, front) - evaluate(seg, back)) / (front - back)) * 1000;
  }

  // Les trois méthodes suivantes partent de la valeur et de la vitesse du canal à `t0` :
  // un changement de cible ne crée jamais de saut. Elles annulent tout segment prévu à
  // partir de `t0`, ce qui permet d'interrompre une chorégraphie déjà planifiée.

  set(t0: number, x: number): this {
    return this.push({ kind: 'set', t0, x0: x });
  }

  tween(t0: number, to: number, durationMs: number, ease: Ease): this {
    return this.push({ kind: 'tween', t0, x0: this.value(t0), to, durationMs, ease });
  }

  spring(t0: number, to: number, spring: SpringConfig, extraVelocity = 0): this {
    const v0 = this.velocity(t0) + extraVelocity;
    return this.push({ kind: 'spring', t0, x0: this.value(t0), v0, to, spring });
  }

  // Change la cible des ressorts planifiés à partir de `t` sans toucher à leur date :
  // utile quand la largeur finale de la pilule change pendant l'entrée.
  retargetSprings(t: number, to: number): void {
    for (const seg of this.segments) {
      if (seg.t0 >= t && seg.kind === 'spring') seg.to = to;
    }
  }

  private push(seg: Segment): this {
    this.segments = this.segments.filter((s) => s.t0 < seg.t0);
    this.segments.push(seg);
    return this;
  }

  private segmentAt(t: number): Segment {
    for (let i = this.segments.length - 1; i >= 0; i--) {
      if (this.segments[i].t0 <= t) return this.segments[i];
    }
    return this.segments[0];
  }
}

function evaluate(seg: Segment, t: number): number {
  switch (seg.kind) {
    case 'set':
      return seg.x0;
    case 'tween': {
      if (seg.durationMs <= 0) return seg.to;
      const u = Math.min(Math.max((t - seg.t0) / seg.durationMs, 0), 1);
      return seg.x0 + (seg.to - seg.x0) * seg.ease(u);
    }
    case 'spring':
      return springValue(seg.x0 - seg.to, seg.v0, seg.spring, Math.max(t - seg.t0, 0) / 1000) + seg.to;
  }
}

// Écart à la cible d'un ressort parti de l'écart `e` avec la vitesse `v0`, après `dt` secondes.
export function springValue(e: number, v0: number, { stiffness, damping }: SpringConfig, dt: number): number {
  const w0 = Math.sqrt(Math.max(stiffness, 1e-6));
  const zeta = damping / (2 * w0);
  if (Math.abs(zeta - 1) < 1e-4) {
    return Math.exp(-w0 * dt) * (e + (v0 + w0 * e) * dt);
  }
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * w0 * dt);
    return envelope * (e * Math.cos(wd * dt) + ((v0 + zeta * w0 * e) / wd) * Math.sin(wd * dt));
  }
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - root);
  const r2 = -w0 * (zeta + root);
  const b = (v0 - r1 * e) / (r2 - r1);
  return (e - b) * Math.exp(r1 * dt) + b * Math.exp(r2 * dt);
}
