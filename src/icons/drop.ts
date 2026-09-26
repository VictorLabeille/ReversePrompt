// Icône neutre : une petite goutte blanche avec deux yeux (création originale). Utilisée pour
// un outil sans icône propre, ou quand les icônes de marque sont absentes.
//
// Deux humeurs : « done » (balancement calme) et « needs » (petits sauts, yeux plus grands).

import type { NoticeKind } from '../messages';
import type { Icon } from './icon';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Durée d'un clignement et intervalles pseudo-aléatoires entre deux clignements, en ms.
const BLINK_MS = 130;
const BLINK_GAPS_MS = [2600, 3900, 1700, 4400, 3100];

export class DropIcon implements Icon {
  readonly element: SVGSVGElement;
  private readonly body: SVGGElement;
  private readonly eyes: SVGGElement;
  private readonly mouth: SVGPathElement;
  private mood: NoticeKind = 'done';
  private moodSince = 0;

  constructor(sizePx: number) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('width', String(sizePx));
    svg.setAttribute('height', String(sizePx));
    svg.innerHTML = `
      <g data-part="body">
        <path d="M16 3.5 C17.5 7 25.5 13.5 25.5 20 A9.5 9.5 0 0 1 6.5 20 C6.5 13.5 14.5 7 16 3.5 Z"
              fill="var(--island-character)"/>
        <g data-part="eyes" fill="var(--island-character-ink)">
          <ellipse cx="12.6" cy="19.2" rx="1.55" ry="2.1"/>
          <ellipse cx="19.4" cy="19.2" rx="1.55" ry="2.1"/>
        </g>
        <path data-part="mouth" fill="none" stroke="var(--island-character-ink)"
              stroke-width="1.3" stroke-linecap="round"/>
      </g>`;
    this.element = svg;
    this.body = svg.querySelector('[data-part="body"]')!;
    this.eyes = svg.querySelector('[data-part="eyes"]')!;
    this.mouth = svg.querySelector('[data-part="mouth"]')!;
  }

  setMood(mood: NoticeKind, t: number): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.moodSince = t;
  }

  update(t: number): void {
    const s = t / 1000;
    const excited = this.mood === 'needs';

    // Balancement autour de la base de la goutte ; en « needs », petits sauts rythmés.
    const sway = Math.sin(s * Math.PI * 2 * (excited ? 0.9 : 0.45)) * (excited ? 5 : 3.5);
    const hop = excited ? -Math.abs(Math.sin(s * Math.PI * 2.2)) * 2.2 : Math.sin(s * Math.PI * 1.1) * 0.5;
    // Petite secousse au changement d'humeur, amortie sur 400 ms.
    const since = t - this.moodSince;
    const wiggle = since < 400 ? Math.sin(since / 22) * (1 - since / 400) * 6 : 0;
    this.body.setAttribute('transform', `translate(0 ${hop.toFixed(2)}) rotate(${(sway + wiggle).toFixed(2)} 16 29.5)`);

    const eyeScale = (excited ? 1.18 : 1) * blinkScale(t);
    this.eyes.setAttribute('transform', `translate(0 19.2) scale(1 ${eyeScale.toFixed(3)}) translate(0 -19.2)`);

    this.mouth.setAttribute(
      'd',
      excited ? 'M14.9 24.6 Q16 23.4 17.1 24.6 Q16 25.8 14.9 24.6 Z' : 'M13.9 23.6 Q16 25.6 18.1 23.6',
    );
  }
}

function blinkScale(t: number): number {
  const cycle = BLINK_GAPS_MS.reduce((a, b) => a + b, 0);
  let local = ((t % cycle) + cycle) % cycle;
  for (const gap of BLINK_GAPS_MS) {
    if (local < gap) {
      const into = local - (gap - BLINK_MS);
      if (into < 0) return 1;
      return 0.12 + 0.88 * Math.abs(Math.cos((into / BLINK_MS) * Math.PI));
    }
    local -= gap;
  }
  return 1;
}
