// Horloge virtuelle : toutes les animations lisent ce temps, jamais `performance.now()`.
// Le playground s'en sert pour le ralenti (speed), la pause et l'avance image par image ;
// l'app la laisse à vitesse 1.
export class Clock {
  time = 0;
  speed = 1;
  paused = false;
  private lastReal: number | undefined;

  // Avance selon le temps réel écoulé depuis le dernier appel. Le premier appel après
  // `resync()` n'avance pas : une boucle qui redémarre ne fait pas sauter l'animation.
  tick(realNow: number): number {
    if (this.lastReal !== undefined && !this.paused) {
      this.time += (realNow - this.lastReal) * this.speed;
    }
    this.lastReal = realNow;
    return this.time;
  }

  step(ms: number): void {
    this.time += ms;
  }

  resync(): void {
    this.lastReal = undefined;
  }
}
