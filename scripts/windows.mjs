#!/usr/bin/env node
// Pilote la partie Windows (Tauri) depuis WSL.
//
// La source de vérité est ce dépôt, dans WSL. Tauri se compile côté Windows, depuis un miroir
// sur disque NTFS : compiler directement sur \\wsl.localhost casse les scripts de build et les
// outils Windows, et node_modules / target contiennent des binaires propres à chaque système.
//
//   node scripts/windows.mjs sync      copie le dépôt vers le miroir (seulement ce qui a changé)
//   node scripts/windows.mjs dev       sync + `tauri dev` (l'app charge le Vite de WSL)
//   node scripts/windows.mjs build     sync + installeur NSIS
//   node scripts/windows.mjs install   sync + build + installation silencieuse (par utilisateur)
//   node scripts/windows.mjs test      sync + `cargo test`
//   node scripts/windows.mjs run <cmd> sync + une commande quelconque dans le miroir
//
// Le miroir vit dans %LOCALAPPDATA%\ReversePrompt-build. Il ne s'édite jamais à la main :
// tout changement y est écrasé à la synchro suivante.

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');

// Jamais copiés : binaires propres à chaque système, sorties de build, historique git.
// `src/icons/brand/` est copié : ignoré par git, mais nécessaire au build local.
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'src-tauri/target', 'src-tauri/gen']);

function windowsEnv(name) {
  const out = execFileSync('cmd.exe', ['/d', '/c', `echo %${name}%`], { cwd: '/mnt/c', encoding: 'utf8' });
  return out.trim();
}

function toWsl(winPath) {
  return execFileSync('wslpath', ['-u', winPath], { encoding: 'utf8' }).trim();
}

const MIRROR_WIN = `${windowsEnv('LOCALAPPDATA')}\\ReversePrompt-build`;
const MIRROR = toWsl(MIRROR_WIN);

// Copie les fichiers nouveaux ou modifiés (taille ou date), supprime ceux qui ont disparu.
function sync() {
  let copied = 0;
  let removed = 0;
  const walk = (dir) => {
    const rel = relative(REPO, dir);
    const target = join(MIRROR, rel);
    mkdirSync(target, { recursive: true });
    const names = new Set();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (EXCLUDED.has(relPath)) continue;
      names.add(entry.name);
      const src = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(src);
      } else if (entry.isFile()) {
        const dst = join(target, entry.name);
        const s = statSync(src);
        const d = existsSync(dst) ? statSync(dst) : null;
        if (!d || d.size !== s.size || Math.abs(d.mtimeMs - s.mtimeMs) > 2000) {
          copyFileSync(src, dst);
          utimesSync(dst, s.atime, s.mtime);
          copied++;
        }
      }
    }
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (EXCLUDED.has(relPath) || names.has(entry.name)) continue;
      rmSync(join(target, entry.name), { recursive: true, force: true });
      removed++;
    }
  };
  walk(REPO);
  console.log(`miroir : ${MIRROR_WIN} (${copied} copiés, ${removed} supprimés)`);
}

// Exécute une commande dans le miroir, côté Windows, en relayant sa sortie.
// Pas de guillemets dans la commande : l'interop WSL les échappe en \" que cmd.exe ne comprend
// pas. Le chemin du miroir n'a pas d'espace.
function win(command) {
  console.log(`> ${command}`);
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `cd /d ${MIRROR_WIN} && ${command}`], {
    cwd: '/mnt/c',
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// node_modules Windows : réinstallé seulement quand le verrou a changé.
function ensureDeps() {
  const lock = join(MIRROR, 'package-lock.json');
  const stamp = join(MIRROR, 'node_modules', '.lock-stamp');
  const lockTime = statSync(lock).mtimeMs;
  if (existsSync(stamp) && Math.abs(statSync(stamp).mtimeMs - lockTime) < 2000) return;
  win('npm ci --no-audit --no-fund');
  mkdirSync(dirname(stamp), { recursive: true });
  copyFileSync(lock, stamp);
  utimesSync(stamp, new Date(), new Date(lockTime));
}

function installerPath() {
  const dir = join(MIRROR, 'src-tauri/target/release/bundle/nsis');
  const exe = readdirSync(dir).find((f) => f.endsWith('-setup.exe'));
  if (!exe) throw new Error(`aucun installeur dans ${dir}`);
  return `${MIRROR_WIN}\\src-tauri\\target\\release\\bundle\\nsis\\${exe}`;
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'sync':
    sync();
    break;
  case 'dev':
    sync();
    ensureDeps();
    win('npx tauri dev');
    break;
  case 'build':
    sync();
    ensureDeps();
    win('npx tauri build');
    console.log(installerPath());
    break;
  case 'install': {
    sync();
    ensureDeps();
    win('npx tauri build');
    // L'app en cours doit être fermée, sinon l'installeur ne peut pas remplacer l'exécutable.
    spawnSync('taskkill.exe', ['/im', 'reverse-prompt.exe', '/f'], { cwd: '/mnt/c', stdio: 'ignore' });
    win(`${installerPath()} /S`);
    console.log('installé');
    break;
  }
  case 'test':
    sync();
    win('cd src-tauri && cargo test');
    break;
  case 'run':
    sync();
    ensureDeps();
    win(rest.join(' '));
    break;
  default:
    console.error('usage : node scripts/windows.mjs sync|dev|build|install|test|run <cmd>');
    process.exit(2);
}
