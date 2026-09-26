// Point d'entrée de l'overlay. Dans l'app Tauri, l'île est branchée aux événements de l'app
// (src/app/bridge.ts) ; dans un navigateur (`npm run dev`), elle se pilote depuis la console.
import { animation } from './config/animation';
import { Island } from './island';
import type { Bridge } from './app/bridge';
import './theme/black.css';

const inTauri = '__TAURI_INTERNALS__' in window;
let bridge: Bridge | null = null;

const island = new Island(document.getElementById('island')!, animation, {
  onFrame: () => bridge?.updateHit(),
  onStateChange: (state) => bridge?.stateChanged(state),
});

await island.warmup();

if (inTauri) {
  const { Bridge } = await import('./app/bridge');
  bridge = new Bridge(island);
  await bridge.connect(animation);
}

// Accès de développement depuis la console : island.show('done'), island.dismiss('close')…
Object.assign(window, { island });
