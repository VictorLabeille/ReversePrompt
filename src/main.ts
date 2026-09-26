// Point d'entrée de l'overlay (future fenêtre Tauri). Pour l'instant il ne fait que monter
// l'île : la réception des événements (hooks des outils) n'est pas encore branchée.
import { animation } from './config/animation';
import { Island } from './island';
import './theme/black.css';

const island = new Island(document.getElementById('island')!, animation);
void island.warmup();

// Accès de développement depuis la console : island.show('done'), island.dismiss('close')…
Object.assign(window, { island });
