// L'île : machine à états, chorégraphie et rendu (forme WebGL + contenu HTML).
// Même code pour l'app et pour le playground : seul ce qui l'entoure change.
//
// États : hidden → entering → shown → exiting → hidden.
//   show()    fait apparaître l'île, ou relance un « pulse » si elle est déjà là,
//             ou annule une sortie en cours sans saut visuel.
//   dismiss() la fait sortir (clic, fermeture, réponse dans le terminal…).
// La chorégraphie de chaque transition est décrite dans docs/animation.md.

import { Channel } from './anim/channel';
import { Clock } from './anim/clock';
import { easeInCubic, easeInOutSine, easeInQuad, easeOutCubic } from './anim/ease';
import { BlobRenderer, type BlobStyle, type Rgba } from './blob/renderer';
import type { AnimationConfig } from './config/animation';
import { createIcon, type Icon, type Source } from './icons/icon';
import { pickMessage, type NoticeKind } from './messages';
import './island.css';

export type IslandState = 'hidden' | 'entering' | 'shown' | 'exiting';
export type DismissReason = 'click' | 'close' | 'external';
export type { Source };

export interface ShowOptions {
  source?: Source;
  text?: string;
}

export interface FrameInfo {
  realNow: number;
  workMs: number;
  state: IslandState;
}

interface IslandOptions {
  clock?: Clock;
  onFrame?: (info: FrameInfo) => void;
  onStateChange?: (state: IslandState) => void;
}

// Texte en cours de frappe : `widths[i]` est la largeur de la pilule quand i lettres sont tapées.
interface Typing {
  text: string;
  start: number;
  widths: number[];
}

// Valeur de la pointe du fil tant qu'il n'a pas cassé : il descend jusqu'à la tête.
const THREAD_ATTACHED = 1e4;

function createChannels() {
  return {
    headY: new Channel(-20),
    headW: new Channel(0),
    headH: new Channel(0),
    lipW: new Channel(0),
    lipH: new Channel(0),
    threadTip: new Channel(THREAD_ATTACHED),
    threadTipR: new Channel(0),
    threadTopR: new Channel(0),
    scale: new Channel(1),
    iconOpacity: new Channel(0),
    iconScale: new Channel(1),
    textOpacity: new Channel(0),
  };
}

// Pas d'échantillonnage pour trouver l'instant où la pilule atteint le seuil d'apparition du contenu.
const CONTENT_START_SAMPLE_MS = 4;
const CONTENT_START_SEARCH_MS = 1500;

export class Island {
  readonly clock: Clock;
  private readonly renderer: BlobRenderer;
  private readonly content: HTMLDivElement;
  private readonly row: HTMLDivElement;
  private readonly iconBox: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private readonly caret: HTMLSpanElement;
  private readonly measureCtx: CanvasRenderingContext2D;
  private icon: Icon;
  private source: Source = 'generic';
  private ch = createChannels();
  private style!: BlobStyle;
  private shadowAlpha = 0;

  private _state: IslandState = 'hidden';
  private typing: Typing = { text: '', start: 0, widths: [0] };
  private shownChars = -1;
  private impactAt = 0;
  private entryEndAt = 0;
  private exitEndAt = 0;
  private lastAttention = 0;
  private rafId = 0;
  private warming = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly cfg: AnimationConfig,
    private readonly options: IslandOptions = {},
  ) {
    this.clock = options.clock ?? new Clock();
    root.classList.add('island');

    const canvas = document.createElement('canvas');
    this.content = document.createElement('div');
    this.content.className = 'island-content';
    this.row = document.createElement('div');
    this.row.className = 'island-row';
    this.iconBox = document.createElement('div');
    this.iconBox.className = 'island-icon';
    this.text = document.createElement('span');
    this.text.className = 'island-text';
    this.caret = document.createElement('span');
    this.caret.className = 'island-caret';
    this.icon = createIcon(this.source, cfg.pill.iconSizePx);
    this.iconBox.append(this.icon.element);
    this.row.append(this.iconBox, this.text, this.caret);
    this.content.append(this.row);
    root.append(canvas, this.content);

    this.renderer = new BlobRenderer(canvas);
    this.measureCtx = document.createElement('canvas').getContext('2d')!;
    this.layout();
    this.refreshTheme();
    this.hideContent();
  }

  get state(): IslandState {
    return this._state;
  }

  // À rappeler quand la taille de fenêtre, le facteur d'échelle ou les marges changent.
  layout(): void {
    const { window: win, pill, typing } = this.cfg;
    this.root.style.width = `${win.widthPx}px`;
    this.root.style.height = `${win.heightPx}px`;
    this.renderer.resize(win.widthPx, win.heightPx, window.devicePixelRatio || 1);
    this.row.style.height = `${pill.heightPx}px`;
    this.row.style.paddingLeft = `${pill.paddingLeftPx}px`;
    this.row.style.gap = `${pill.gapPx}px`;
    this.iconBox.style.width = this.iconBox.style.height = `${pill.iconSizePx}px`;
    this.caret.style.width = `${typing.caretWidthPx}px`;
    this.caret.style.marginLeft = `${typing.caretGapPx - pill.gapPx}px`;
    this.renderNow();
  }

  // Relit les variables CSS du thème.
  refreshTheme(): void {
    const css = getComputedStyle(this.root);
    const num = (name: string) => parseFloat(css.getPropertyValue(name)) || 0;
    const shadow = parseColor(this.measureCtx, css.getPropertyValue('--island-shadow-color'));
    shadow[3] *= num('--island-shadow-opacity');
    this.shadowAlpha = shadow[3];
    this.style = {
      edgeOffset: 0,
      edgeSmooth: 0,
      headSmooth: 0,
      fill: parseColor(this.measureCtx, css.getPropertyValue('--island-fill')),
      shadow,
      shadowBlur: num('--island-shadow-blur'),
      shadowOffsetY: num('--island-shadow-offset-y'),
    };
    this.renderNow();
  }

  show(kind: NoticeKind, { source = this.source, text = pickMessage(kind) }: ShowOptions = {}): void {
    this.startLoop();
    const t = this.clock.time;
    const changed = text !== this.typing.text || source !== this.source;
    this.setSource(source, kind, t);
    this.lastAttention = t;

    switch (this._state) {
      case 'hidden':
        this.scheduleEntry(t, text);
        this.setState('entering');
        break;
      case 'entering':
      case 'shown':
        if (t < this.impactAt) {
          // La goutte n'a pas encore atterri : on change le texte avant qu'il ne soit tapé.
          this.scheduleTyping(this.typing.start, text);
        } else {
          this.pulse(t, changed ? text : null);
        }
        break;
      case 'exiting':
        this.recover(t, text);
        this.setState('entering');
        break;
    }
  }

  dismiss(reason: DismissReason): void {
    if (this._state === 'hidden' || this._state === 'exiting') return;
    this.startLoop();
    const t = this.clock.time;
    const { interaction } = this.cfg;
    let start = t;
    if (reason === 'click') {
      this.ch.scale.tween(t, interaction.pressScale, interaction.pressMs, easeOutCubic);
      start = t + interaction.pressMs;
    }
    this.ch.scale.spring(start, 1, interaction.hover);
    this.scheduleExit(start);
    this.setState('exiting');
  }

  hover(over: boolean): void {
    if (this._state !== 'entering' && this._state !== 'shown') return;
    const t = this.clock.time;
    this.ch.scale.spring(t, over ? this.cfg.interaction.hoverScale : 1, this.cfg.interaction.hover);
    this.startLoop();
  }

  // Le point (px logiques, repère de la fenêtre) est-il sur la pilule ?
  hitTest(x: number, y: number): boolean {
    if (this._state !== 'entering' && this._state !== 'shown') return false;
    const t = this.clock.time;
    if (t < this.impactAt) return false;
    const sc = this.ch.scale.value(t);
    const hw = this.ch.headW.value(t) * sc;
    const hh = this.ch.headH.value(t) * sc;
    const r = Math.min(hw, hh);
    const qx = Math.abs(x - this.cfg.window.widthPx / 2) - hw + r;
    const qy = Math.abs(y - this.ch.headY.value(t)) - hh + r;
    return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r <= 1;
  }

  // Fait apparaître l'île directement dans son état final, sans animation d'entrée.
  showInstant(kind: NoticeKind, { source = this.source, text = pickMessage(kind) }: ShowOptions = {}): void {
    this.hideInstant();
    const t = this.clock.time;
    const { pill } = this.cfg;
    this.setSource(source, kind, t);
    this.lastAttention = t;
    this.typing = this.computeTyping(text, -Infinity);
    this.row.style.width = `${this.finalWidth()}px`;
    this.shownChars = -1;
    this.ch.headY.set(t, pill.centerYPx);
    this.ch.headW.set(t, this.finalWidth() / 2);
    this.ch.headH.set(t, pill.heightPx / 2);
    this.ch.iconOpacity.set(t, 1);
    this.ch.textOpacity.set(t, 1);
    this.impactAt = this.entryEndAt = t;
    this.setState('shown');
    this.startLoop();
    this.renderNow();
  }

  // Réglage en direct (playground) : relit la config et ramène une pilule déjà posée vers
  // ses nouvelles valeurs de repos, par ressort.
  applyConfig(): void {
    this.layout();
    const t = this.clock.time;
    if (this._state !== 'shown' && !(this._state === 'entering' && t >= this.impactAt)) return;
    const { pill, entry } = this.cfg;
    this.typing = this.computeTyping(this.typing.text, this.typing.start);
    this.row.style.width = `${this.finalWidth()}px`;
    this.ch.headY.spring(t, pill.centerYPx, entry.bounce);
    this.ch.headW.spring(t, this.widthAt(t) / 2, entry.spread);
    this.ch.headH.spring(t, pill.heightPx / 2, entry.spread);
    this.startLoop();
  }

  hideInstant(): void {
    this.stopLoop();
    this.ch = createChannels();
    this.setState('hidden');
    this.renderer.clear();
    this.hideContent();
  }

  // Dessine l'instant courant de l'horloge sans l'avancer (pause, image par image, réglages).
  renderNow(): void {
    if (this._state === 'hidden') return;
    if (!this.frame(this.clock.time)) this.stopLoop();
  }

  // Préchauffage : compile le shader, charge la police et joue une entrée invisible,
  // pour que la toute première notification ne saccade pas.
  async warmup(): Promise<void> {
    await document.fonts.ready;
    const saved = this.root.style.opacity;
    this.root.style.opacity = '0';
    this.warming = true;
    const t0 = this.clock.time;
    this.scheduleEntry(t0, pickMessage('done'));
    this._state = 'entering';
    for (let t = t0; t <= this.entryEndAt; t += 50) this.frame(t);
    this.hideInstant();
    this.warming = false;
    this.root.style.opacity = saved;
  }

  // --- Chorégraphies -------------------------------------------------------------------

  // Entrée : un film d'encre apparaît sous toute la largeur de l'encoche, se rassemble au
  // centre en une goutte qui pend puis tombe. Le fil casse pendant la chute et remonte dans
  // l'encoche ; la goutte atterrit, s'étale en petite pilule, puis l'icône apparaît et le texte
  // se tape, la pilule s'allongeant avec lui.
  private scheduleEntry(T: number, text: string): void {
    const { notch, drop, thread, pill, entry, content, typing } = this.cfg;
    const c = (this.ch = createChannels());
    const t1 = T + entry.filmMs;
    const t2 = t1 + entry.gatherMs;
    const t3 = t2 + entry.hangMs;
    const t4 = t3 + entry.fallMs;
    const tBreak = t3 + entry.fallMs * entry.breakRatio;
    const tEmerge = t1 + entry.gatherMs * 0.45;
    const r0 = drop.startRadiusPx;
    const rHang = drop.hangRadiusPx;
    this.typing = this.computeTyping(text, Infinity);

    // Film d'encre, puis rassemblement au centre, puis absorption une fois le fil cassé.
    c.lipW
      .set(T, (notch.widthPx / 2) * 0.7)
      .tween(T, notch.widthPx / 2, entry.filmMs, easeOutCubic)
      .tween(t1, notch.gatherHalfWidthPx, entry.gatherMs, easeInOutSine)
      .tween(tBreak, 0, thread.retractMs * 1.5, easeInOutSine);
    c.lipH
      .set(T, 0)
      .tween(T, notch.filmHeightPx, entry.filmMs, easeOutCubic)
      .tween(t1, notch.gatherHeightPx, entry.gatherMs, easeInOutSine)
      .tween(tBreak, 0, thread.retractMs * 1.5, easeInOutSine);

    // La goutte sort du rassemblement, pend, s'alourdit, tombe et rebondit à l'atterrissage.
    c.headY
      .set(T, -r0)
      .tween(tEmerge, drop.hangYPx, t2 - tEmerge, easeOutCubic)
      .tween(t2, drop.sagYPx, entry.hangMs, easeInOutSine)
      .tween(t3, pill.centerYPx, entry.fallMs, easeInQuad)
      .spring(t4, pill.centerYPx, entry.bounce);
    for (const [channel, final] of [
      [c.headW, this.typing.widths[0] / 2],
      [c.headH, pill.heightPx / 2],
    ] as const) {
      channel
        .set(T, 0)
        .tween(tEmerge, r0, (t2 - tEmerge) * 0.6, easeOutCubic)
        .tween(t2, rHang, entry.hangMs, easeInOutSine)
        .spring(t4, final, entry.spread);
    }

    // Le fil : épais pendant le rassemblement, il s'affine à la chute, casse et remonte.
    c.threadTopR.set(T, thread.neckRadiusPx).spring(t3, thread.thinRadiusPx, entry.thin);
    c.threadTipR
      .set(T, thread.neckRadiusPx)
      .tween(t2, thread.neckRadiusPx * 0.6, entry.hangMs, easeInOutSine)
      .spring(t3, thread.thinRadiusPx, entry.thin);
    const anchor = -this.cfg.shape.edgeOffsetPx - 2;
    c.threadTip
      .set(tBreak, c.headY.value(tBreak) - rHang)
      .tween(tBreak + 0.001, anchor, thread.retractMs, easeOutCubic);
    for (const channel of [c.threadTopR, c.threadTipR]) {
      channel.tween(tBreak + thread.retractMs, 0, thread.retractMs * 0.3, easeOutCubic);
    }

    // Contenu : l'icône quand la pilule atteint `contentStartRatio` de sa largeur, puis le texte.
    const tc = this.findContentStart(t4);
    c.iconOpacity.set(T, 0).tween(tc, 1, content.iconFadeMs, easeOutCubic);
    c.iconScale.set(T, content.iconScaleFrom).spring(tc, 1, content.iconSpring);
    c.textOpacity.set(T, 1);
    const tType = tc + typing.startDelayMs;
    this.scheduleTyping(tType, text);

    this.impactAt = t4;
    this.entryEndAt = tType + text.length * typing.charMs;
  }

  // Sortie : le contenu s'efface, la pilule se rétracte en goutte et disparaît sur place.
  private scheduleExit(T: number): void {
    const { exit } = this.cfg;
    const c = this.ch;
    const ts = T + exit.shrinkDelayMs;
    const tv = T + exit.vanishDelayMs;

    c.iconOpacity.tween(T, 0, exit.contentFadeMs, easeOutCubic);
    c.textOpacity.tween(T, 0, exit.contentFadeMs, easeOutCubic);
    for (const channel of [c.headW, c.headH]) {
      channel.spring(ts, exit.dropRadiusPx, exit.shrink).tween(tv, 0, exit.vanishMs, easeInCubic);
    }
    this.exitEndAt = tv + exit.vanishMs;
  }

  // Un événement arrivé pendant la sortie : la goutte se regonfle en pilule depuis son état
  // courant, et le nouveau texte se tape.
  private recover(T: number, text: string): void {
    const { pill, entry, content, typing } = this.cfg;
    const c = this.ch;
    this.typing = this.computeTyping(text, Infinity);
    c.headY.spring(T, pill.centerYPx, entry.bounce);
    c.headW.spring(T, this.typing.widths[0] / 2, entry.spread);
    c.headH.spring(T, pill.heightPx / 2, entry.spread);
    c.iconOpacity.tween(T, 1, content.iconFadeMs, easeOutCubic);
    c.iconScale.spring(T, 1, content.iconSpring);
    c.textOpacity.set(T, 1);
    const tType = T + typing.startDelayMs;
    this.scheduleTyping(tType, text);
    this.impactAt = T;
    this.entryEndAt = tType + text.length * typing.charMs;
  }

  // Nouvel événement alors que l'île est visible : petite secousse, et le texte se retape s'il
  // a changé (la pilule revient à la largeur de l'icône puis s'allonge à nouveau).
  private pulse(T: number, newText: string | null, kick = this.cfg.pulse.kickSpeed): void {
    const { pill, entry, typing } = this.cfg;
    this.ch.headY.spring(T, pill.centerYPx, entry.bounce, kick);
    if (newText === null) return;
    const tType = T + typing.retypeDelayMs;
    this.typing = this.computeTyping(newText, tType);
    this.ch.headW.spring(T, this.typing.widths[0] / 2, typing.widthSpring);
    this.scheduleTyping(tType, newText);
    if (this._state === 'shown') this.setState('entering');
    this.entryEndAt = tType + newText.length * typing.charMs;
  }

  // Planifie la frappe : une lettre toutes les `charMs`, et à chaque lettre la largeur de la
  // pilule repart par ressort vers sa nouvelle valeur. La pilule vise `leadPx` de plus que le
  // texte tapé (sans dépasser sa largeur finale) : elle s'ouvre devant le texte au lieu de le
  // suivre, sinon le texte a l'air de sortir de la pilule.
  private scheduleTyping(start: number, text: string): void {
    const { typing } = this.cfg;
    this.typing = this.computeTyping(text, start);
    this.shownChars = -1;
    const final = this.finalWidth();
    for (let i = 1; i <= text.length; i++) {
      const target = Math.min(this.typing.widths[i] + typing.leadPx, final);
      this.ch.headW.spring(start + (i - 1) * typing.charMs, target / 2, typing.widthSpring);
    }
    this.row.style.width = `${this.finalWidth()}px`;
  }

  private findContentStart(impact: number): number {
    const target = (this.typing.widths[0] / 2) * this.cfg.entry.contentStartRatio;
    for (let t = impact; t < impact + CONTENT_START_SEARCH_MS; t += CONTENT_START_SAMPLE_MS) {
      if (this.ch.headW.value(t) >= target) return t;
    }
    return impact;
  }

  // --- Image ---------------------------------------------------------------------------

  // Calcule et dessine l'instant `t`. Renvoie false quand l'île est (ou vient d'être) cachée.
  private frame(t: number): boolean {
    const { cfg, ch } = this;
    if (this._state === 'hidden') return false;

    if (this._state === 'entering' && t >= this.entryEndAt) this.setState('shown');
    if (this._state === 'shown' && cfg.reminder.enabled && t - this.lastAttention >= cfg.reminder.intervalMs) {
      this.lastAttention = t;
      this.pulse(t, null, cfg.reminder.kickSpeed);
    }
    if (this._state === 'exiting' && t >= this.exitEndAt) {
      this.hideInstant();
      return false;
    }

    // Étirement selon la vitesse (squash & stretch) : fort sur la goutte, atténué sur la pilule.
    const headY = ch.headY.value(t);
    const hw = Math.max(ch.headW.value(t), 0);
    const hh = Math.max(ch.headH.value(t), 0);
    const sc = ch.scale.value(t);
    const dropness = hh > 0 ? clamp(1 - (hw - hh) / hh, 0, 1) : 1;
    const stretch =
      Math.min(Math.abs(ch.headY.velocity(t)) * cfg.drop.stretchPerSpeed, cfg.drop.maxStretch) *
      (dropness + (1 - dropness) * cfg.drop.pillStretchRatio);

    this.style.edgeOffset = cfg.shape.edgeOffsetPx;
    this.style.edgeSmooth = cfg.shape.edgeSmoothPx;
    this.style.headSmooth = cfg.shape.headSmoothPx;
    // L'ombre n'appartient qu'à la pilule : sur la goutte, elle ferait un halo sale.
    this.style.shadow[3] = this.shadowAlpha * (1 - dropness);
    this.renderer.render(
      {
        headX: cfg.window.widthPx / 2,
        headY,
        headHalfW: (hw / (1 + stretch * dropness)) * sc,
        headHalfH: hh * (1 + stretch) * sc,
        threadTipR: ch.threadTipR.value(t),
        threadTopR: ch.threadTopR.value(t),
        threadTipY: Math.min(ch.threadTip.value(t), headY),
        lipHalfW: ch.lipW.value(t),
        lipH: ch.lipH.value(t),
      },
      this.style,
    );

    this.renderContent(t, headY, hw, hh, sc);
    return true;
  }

  private renderContent(t: number, headY: number, hw: number, hh: number, sc: number): void {
    const { ch, cfg } = this;
    const iconOpacity = ch.iconOpacity.value(t);
    const textOpacity = ch.textOpacity.value(t);
    if (iconOpacity <= 0.001 && (textOpacity <= 0.001 || this.typedCount(t) === 0)) {
      this.hideContent();
      return;
    }
    this.content.style.visibility = 'visible';
    this.content.style.transform = `translate3d(${cfg.window.widthPx / 2}px, ${headY}px, 0) scale(${sc})`;
    // La rangée démarre au bord gauche courant de la pilule et est découpée à sa forme.
    const inset = Math.max(cfg.pill.heightPx / 2 - hh, 0);
    const right = Math.max(this.finalWidth() - 2 * hw, 0);
    this.row.style.transform = `translate3d(${-hw}px, ${-cfg.pill.heightPx / 2}px, 0)`;
    this.row.style.clipPath = `inset(${inset}px ${right}px ${inset}px 0 round ${Math.min(hw, hh)}px)`;

    this.iconBox.style.opacity = String(iconOpacity);
    this.iconBox.style.transform = `scale(${ch.iconScale.value(t)})`;
    this.icon.update(t);

    const typed = this.typedCount(t);
    if (typed !== this.shownChars) {
      this.text.textContent = this.typing.text.slice(0, typed);
      this.shownChars = typed;
    }
    this.text.style.opacity = String(textOpacity);
    // Opacité et non `visibility` : un enfant en `visibility: visible` s'affiche même quand le
    // conteneur est caché, ce qui laissait le curseur seul à l'écran au lancement.
    this.caret.style.opacity = this.caretVisible(t) ? String(textOpacity) : '0';
  }

  private hideContent(): void {
    this.content.style.visibility = 'hidden';
  }

  // --- Texte et largeur ----------------------------------------------------------------

  private typedCount(t: number): number {
    const { start, text } = this.typing;
    if (t < start) return 0;
    return Math.min(text.length, Math.floor((t - start) / this.cfg.typing.charMs) + 1);
  }

  // Curseur plein pendant la frappe, puis clignotant pendant `caretLingerMs`.
  private caretVisible(t: number): boolean {
    const { charMs, caretLingerMs, caretBlinkMs } = this.cfg.typing;
    const { start, text } = this.typing;
    const end = start + text.length * charMs;
    if (t < start || t >= end + caretLingerMs) return false;
    if (t < end) return true;
    return Math.floor((t - end) / caretBlinkMs) % 2 === 1;
  }

  private widthAt(t: number): number {
    return this.typing.widths[this.typedCount(t)];
  }

  private finalWidth(): number {
    return this.typing.widths[this.typing.widths.length - 1];
  }

  private computeTyping(text: string, start: number): Typing {
    const { pill, typing } = this.cfg;
    const css = getComputedStyle(this.text);
    this.measureCtx.font = `${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
    const iconOnly = pill.paddingLeftPx + pill.iconSizePx + pill.paddingRightPx;
    const withText = iconOnly + pill.gapPx + typing.caretGapPx + typing.caretWidthPx;
    const widths = [iconOnly];
    for (let i = 1; i <= text.length; i++) {
      const w = withText + Math.ceil(this.measureCtx.measureText(text.slice(0, i)).width);
      widths.push(Math.min(w, pill.maxWidthPx));
    }
    return { text, start, widths };
  }

  private setSource(source: Source, kind: NoticeKind, t: number): void {
    if (source !== this.source) {
      this.source = source;
      this.icon = createIcon(source, this.cfg.pill.iconSizePx);
      this.iconBox.replaceChildren(this.icon.element);
    }
    this.icon.setMood(kind, t);
  }

  // --- Boucle --------------------------------------------------------------------------

  private setState(state: IslandState): void {
    if (state === this._state) return;
    this._state = state;
    if (!this.warming) this.options.onStateChange?.(state);
  }

  private startLoop(): void {
    if (this.rafId) return;
    this.clock.resync();
    this.clock.tick(performance.now());
    this.rafId = requestAnimationFrame(this.loop);
  }

  private stopLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  // Une seule boucle, active seulement quand l'île est visible ou en mouvement.
  private readonly loop = (realNow: number): void => {
    const start = performance.now();
    const alive = this.frame(this.clock.tick(realNow));
    this.rafId = alive ? requestAnimationFrame(this.loop) : 0;
    this.options.onFrame?.({ realNow, workMs: performance.now() - start, state: this._state });
  };
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(Math.max(x, min), max);
}

// Convertit n'importe quelle couleur CSS en RGBA normalisé, via le canevas 2D.
function parseColor(ctx: CanvasRenderingContext2D, value: string): Rgba {
  ctx.fillStyle = '#000';
  ctx.fillStyle = value.trim() || '#000';
  const s = String(ctx.fillStyle);
  if (s.startsWith('#')) {
    const n = parseInt(s.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  const [r, g, b, a = 1] = (s.match(/[\d.]+/g) ?? []).map(Number);
  return [r / 255, g / 255, b / 255, a];
}
