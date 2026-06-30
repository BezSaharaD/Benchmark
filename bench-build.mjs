#!/usr/bin/env node
/**
 * bench-build.mjs — переносимый бенч БАНДЛЕРОВ Next.js: rspack vs webpack vs turbopack.
 *
 * Что меряет (на одном и том же приложении, СТРОГО серийно — один билд за раз):
 *   • rspack / webpack / turbopack — на ВРЕМЕННОМ минимальном конфиге (дефолтный чанкинг)
 *     → честное сравнение самих движков;
 *   • <engine>-clean — чистый Next + textbook splitChunks/cacheGroups (то, что настраивает
 *     любая грамотная команда) → «потолок правильных настроек»;
 *   • <engine>-custom — на РЕАЛЬНОМ next.config приложения (вся ваша оптимизация).
 *   Каждый вариант: COLD (чистый distDir) + HOT (2-й прогон с кэшем; off через --cold-only).
 *   Метрики: время · пик RAM (RSS дерева процессов) · CPU avg→PEAK (дельта os.cpus(), в «ядрах»;
 *     avg = по всей сборке, PEAK = самое параллельное окно) · вес бандла (Σ raw + 3 топа).
 *
 * ТРЕБОВАНИЯ / переносимость:
 *   • Node 18+ (без glob/внешних зависимостей); запускать ИЗ КОРНЯ репозитория.
 *   • Поддерживается конфиг `next.config.mjs`. Если у приложения `next.config.ts/.js` и НЕТ `.mjs` —
 *     тул прерывается (чтобы не сломать билд). Если конфига нет вообще — clean/минимал работают
 *     (временный конфиг создаётся и удаляется), custom-варианты пропускаются.
 *   • Приложение авто-детектится (apps/*, корень) или задаётся `--app=apps/web`.
 *   • transpilePackages берутся из `packages/*` и `libs/*` (другой лейаут — поправьте detectWorkspacePkgs).
 *   • rspack-варианты включаются только если установлен `next-rspack`, иначе пропускаются.
 *   • RAM: Windows wmic→PowerShell-фолбэк, Unix `ps`; CPU — os.cpus() (кросс-платформенно).
 *   • custom-вариант делает `{...realConfig, distDir}` — предполагает spreadable-объект в default export.
 *
 * БЕЗОПАСНОСТЬ: next.config.mjs бэкапится и ВОССТАНАВЛИВАЕТСЯ через finally И по SIGINT/SIGTERM
 *   (Ctrl-C не оставит подменённый конфиг). Билд идёт в ИЗОЛИРОВАННЫЙ distDir (.next-bench) —
 *   рабочий .next и запущенный сервер не трогаются.
 *
 * ВАЖНЫЕ КАВЕАТЫ (для интерпретации):
 *   • turbopack ИГНОРИРУЕТ webpack()/cacheGroups → его clean/custom = тот же дефолт;
 *   • вес здесь RAW (без пост-обработки: mangle/compress/dedup) → не равен прод-бандлу;
 *   • CPU avg занижен длинными СЕРИЙНЫМИ фазами Next (page-data/RSC) — смотрите PEAK для параллелизма.
 *
 * Запуск:  node scripts/bench-build.mjs [--app=apps/main] [--only=rspack,turbopack,rspack-custom]
 *          [--cold-only] [--md] [--dry]
 */
import { spawn, execSync } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, delimiter, basename } from 'node:path';
import os from 'node:os';

const ROOT = process.cwd();
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const has = (flag) => process.argv.includes(`--${flag}`);
const COLD_ONLY = has('cold-only');
const DRY = has('dry');
const MD = has('md');
const ONLY = arg('only') ? arg('only').split(',') : null;
const SAMPLE_MS = 700;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;
const DIST = '.next-bench';
const NCORES = os.cpus().length;

// непосредственные поддиректории relParent (замена glob — Node 18+, без зависимостей)
function subdirs(relParent) {
  const abs = join(ROOT, relParent);
  if (!existsSync(abs)) return [];
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `${relParent}/${e.name}`);
  } catch {
    return [];
  }
}

// ───────── авто-детект приложения / конфига / пакетов / next-rspack ─────────
function detectApp() {
  if (arg('app')) return arg('app');
  const cands = ['apps/main', 'apps/web', ...subdirs('apps'), '.'];
  for (const c of cands) {
    if (existsSync(join(ROOT, c, 'next.config.mjs'))) return c.replace(/\\/g, '/');
  }
  return 'apps/main';
}
const APP_REL = detectApp();
const APP = join(ROOT, APP_REL);
const CFG = join(APP, 'next.config.mjs');
const BAK = join(APP, 'next.config.bench-real.mjs');
const STATIC = join(APP, DIST, 'static');
const HAS_MJS = existsSync(CFG); // реальный next.config.mjs уже есть
const HAS_CONFIG = HAS_MJS; // custom-варианты только при наличии next.config.mjs
// чужой тип конфига (мешает безопасной подмене .mjs)
const OTHER_CFG = ['ts', 'cts', 'mts', 'js', 'cjs']
  .map((e) => join(APP, `next.config.${e}`))
  .find(existsSync);
const HAS_RSPACK =
  existsSync(join(ROOT, 'node_modules', 'next-rspack')) ||
  existsSync(join(APP, 'node_modules', 'next-rspack'));
const PATH_WITH_BIN = [
  join(ROOT, 'node_modules', '.bin'),
  join(APP, 'node_modules', '.bin'),
  process.env.PATH ?? '',
].join(delimiter);

// transpilePackages = имена всех workspace-пакетов (кроме самого приложения)
function detectWorkspacePkgs() {
  const names = new Set();
  let appName = '';
  try {
    appName = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')).name ?? '';
  } catch {
    /* нет package.json приложения */
  }
  for (const parent of ['packages', 'libs']) {
    for (const d of subdirs(parent)) {
      try {
        const n = JSON.parse(readFileSync(join(ROOT, d, 'package.json'), 'utf8')).name;
        if (n && n !== appName) names.add(n);
      } catch {
        /* нет package.json в подпапке — skip */
      }
    }
  }
  return [...names];
}
const WS_PKGS = detectWorkspacePkgs();

const REL =
  APP_REL.split('/')
    .map(() => '..')
    .join('/') || '.';

const MINIMAL_CONFIG = `// ВРЕМЕННЫЙ минимальный конфиг (bench-build). Восстанавливается автоматически.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(REL)});
const base = {
  distDir: '${DIST}',
  transpilePackages: ${JSON.stringify(WS_PKGS)},
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  turbopack: { root },
};
let config = base;
if (process.env.TURBOPACK === 'auto' && !process.env.NO_RSPACK) {
  const { default: withRspack } = await import('next-rspack');
  config = withRspack(base);
}
export default config;
`;
const CUSTOM_CONFIG = `// ВРЕМЕННЫЙ кастом-конфиг (bench-build): реальный next.config + distDir-изоляция.
import base from './next.config.bench-real.mjs';
export default { ...base, distDir: '${DIST}', output: undefined };
`;

// «ЧЕСТНЫЙ» конфиг: чистый Next + ТОЛЬКО легитимная нарезка чанков (splitChunks/cacheGroups —
// что настраивает любая грамотная команда). БЕЗ стабов/патчеров/кастом-трансформов.
// Минификация — дефолтная Next (SWC). Это «потолок правильных настроек» без трюков.
const CLEAN_CONFIG = `// ВРЕМЕННЫЙ "честный" конфиг (bench-build). Восстанавливается автоматически.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(REL)});
const base = {
  distDir: '${DIST}',
  transpilePackages: ${JSON.stringify(WS_PKGS)},
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  turbopack: { root },
  webpack(config, { isServer, dev }) {
    // только prod client-bundle; стандартная textbook-нарезка, без хаков
    if (!dev && !isServer) {
      config.optimization = config.optimization ?? {};
      config.optimization.splitChunks = {
        chunks: 'all',
        cacheGroups: {
          framework: {
            test: /[\\\\/]node_modules[\\\\/](react|react-dom|scheduler|next)[\\\\/]/,
            name: 'framework',
            priority: 40,
            enforce: true,
          },
          lib: { test: /[\\\\/]node_modules[\\\\/]/, name: 'lib', priority: 30 },
          commons: { name: 'commons', minChunks: 2, priority: 20 },
        },
      };
    }
    return config;
  },
};
let config = base;
if (process.env.TURBOPACK === 'auto' && !process.env.NO_RSPACK) {
  const { default: withRspack } = await import('next-rspack');
  config = withRspack(base);
}
export default config;
`;

const ALL_VARIANTS = [
  { id: 'rspack', config: 'minimal', flags: [], env: {}, needs: 'rspack' },
  { id: 'webpack', config: 'minimal', flags: ['--webpack'], env: { NO_RSPACK: '1' } },
  { id: 'turbopack', config: 'minimal', flags: ['--turbopack'], env: {} },
  // «честный потолок настроек»: чистый Next + textbook splitChunks, без стабов/трансформов
  { id: 'rspack-clean', config: 'clean', flags: [], env: {}, needs: 'rspack' },
  { id: 'webpack-clean', config: 'clean', flags: ['--webpack'], env: { NO_RSPACK: '1' } },
  // наш реальный конфиг (cacheGroups + стабы + трансформы) — нужен реальный next.config.mjs
  { id: 'rspack-custom', config: 'custom', flags: [], env: {}, needs: 'rspack', needsConfig: true },
  {
    id: 'webpack-custom',
    config: 'custom',
    flags: ['--webpack'],
    env: { NO_RSPACK: '1' },
    needsConfig: true,
  },
];

// ───────── RAM дерева процессов (wmic → PowerShell фолбэк / ps) ─────────
function procRows() {
  if (process.platform === 'win32') {
    try {
      const out = execSync(
        'wmic process get ProcessId,ParentProcessId,WorkingSetSize /format:csv',
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        }
      );
      const rows = out
        .split('\n')
        .map((l) => l.trim().split(','))
        .filter((c) => c.length >= 4 && /^\d+$/.test(c[2]))
        .map((c) => ({ pid: +c[2], ppid: +c[1], ws: +c[3] }));
      if (rows.length) return rows;
    } catch {
      /* wmic нет (Win11 24H2+) → PowerShell */
    }
    try {
      const ps =
        'Get-CimInstance Win32_Process | ForEach-Object { \\"$($_.ProcessId),$($_.ParentProcessId),$($_.WorkingSetSize)\\" }';
      const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return out
        .split('\n')
        .map((l) => l.trim().split(','))
        .filter((c) => c.length === 3 && /^\d+$/.test(c[0]))
        .map((c) => ({ pid: +c[0], ppid: +c[1], ws: +c[2] }));
    } catch {
      return [];
    }
  }
  try {
    const out = execSync('ps -eo pid=,ppid=,rss=', { encoding: 'utf8' });
    return out
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .map((c) => ({ pid: +c[0], ppid: +c[1], ws: +c[2] * 1024 }));
  } catch {
    return [];
  }
}
function treeRssMB(rootPid) {
  const rows = procRows();
  if (!rows.length) return -1;
  const kids = new Map();
  const ws = new Map();
  for (const r of rows) {
    ws.set(r.pid, r.ws);
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r.pid);
  }
  let total = 0;
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += ws.get(pid) ?? 0;
    for (const c of kids.get(pid) ?? []) stack.push(c);
  }
  return total / 1048576;
}

// CPU% за окно (дельта os.cpus(), кросс-платформенно, без спавна)
function cpuAvgPct(c0, c1) {
  let busy = 0;
  let total = 0;
  for (let i = 0; i < c0.length && i < c1.length; i += 1) {
    const a = c0[i].times;
    const b = c1[i].times;
    const tot =
      b.user - a.user + (b.nice - a.nice) + (b.sys - a.sys) + (b.idle - a.idle) + (b.irq - a.irq);
    busy += tot - (b.idle - a.idle);
    total += tot;
  }
  return total > 0 ? (busy / total) * 100 : -1;
}

function bundleWeight() {
  if (!existsSync(STATIC)) return { totalMB: 0, top: [] };
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|css)$/.test(e.name))
        files.push({ p: p.replace(STATIC, '').replace(/\\/g, '/'), b: statSync(p).size });
    }
  };
  walk(STATIC);
  const totalMB = files.reduce((s, f) => s + f.b, 0) / 1048576;
  const top = files
    .sort((a, b) => b.b - a.b)
    .slice(0, 3)
    .map((f) => ({ name: f.p, kb: Math.round(f.b / 1024) }));
  return { totalMB, top };
}

const cleanDist = () => {
  rmSync(join(APP, DIST), { recursive: true, force: true });
};

function runBuild(variant, cold) {
  return new Promise((resolve) => {
    if (cold) cleanDist();
    const t0 = process.hrtime.bigint();
    const child = spawn('next', ['build', ...variant.flags], {
      cwd: APP,
      shell: true,
      windowsHide: true,
      env: { ...process.env, PATH: PATH_WITH_BIN, NODE_ENV: 'production', ...variant.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let peakRam = 0;
    let peakCpu = 0;
    const cpu0 = os.cpus();
    let lastCpu = cpu0;
    let failed = '';
    let tail = '';
    const sample = () => {
      const m = treeRssMB(child.pid);
      if (m > peakRam) peakRam = m;
      const now = os.cpus();
      const p = cpuAvgPct(lastCpu, now);
      if (p > peakCpu) peakCpu = p;
      lastCpu = now;
    };
    setTimeout(sample, 200);
    const sampler = setInterval(sample, SAMPLE_MS);
    const killer = setTimeout(() => {
      failed = 'timeout';
      child.kill('SIGKILL');
    }, BUILD_TIMEOUT_MS);
    const cap = (d) => {
      tail = (tail + d.toString()).slice(-2000);
    };
    child.stderr.on('data', cap);
    child.stdout.on('data', cap);
    child.on('close', (code) => {
      clearInterval(sampler);
      clearTimeout(killer);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (!failed && code !== 0) failed = `exit ${code}`;
      resolve({ ms, peakRam, avgCpu: cpuAvgPct(cpu0, os.cpus()), peakCpu, failed, tail });
    });
    child.on('error', () => {
      clearInterval(sampler);
      clearTimeout(killer);
      resolve({ ms: 0, peakRam, avgCpu: -1, peakCpu: -1, failed: 'spawn-err', tail });
    });
  });
}

// ───────── конфиг: бэкап / подмена / восстановление (безопасно по SIGINT) ─────────
const backupConfig = () => {
  if (HAS_MJS) copyFileSync(CFG, BAK);
};
const installConfig = (kind) => {
  writeFileSync(
    CFG,
    kind === 'custom' ? CUSTOM_CONFIG : kind === 'clean' ? CLEAN_CONFIG : MINIMAL_CONFIG
  );
};
const restoreConfig = () => {
  if (existsSync(BAK)) {
    copyFileSync(BAK, CFG); // вернуть оригинал
    rmSync(BAK, { force: true });
  } else if (!HAS_MJS && existsSync(CFG)) {
    rmSync(CFG, { force: true }); // удалить созданный нами временный (своего .mjs не было)
  }
};

let cleaning = false;
const onInterrupt = (sig) => {
  if (cleaning) return;
  cleaning = true;
  console.log(`\n⚠ ${sig} — восстанавливаю next.config.mjs и выхожу…`);
  try {
    restoreConfig();
  } catch {
    /* лучшее усилие */
  }
  process.exit(130);
};
process.on('SIGINT', () => {
  onInterrupt('SIGINT');
});
process.on('SIGTERM', () => {
  onInterrupt('SIGTERM');
});

const fmt = (ms) => (ms <= 0 ? '—' : `${(ms / 1000).toFixed(1)}s`);
const ram = (mb) =>
  mb <= 0 ? 'n/a' : mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${Math.round(mb)}MB`;
const coresN = (pct) => (pct < 0 ? '—' : ((pct / 100) * NCORES).toFixed(1));
const cpuCell = (avg, peak) => (avg < 0 ? 'n/a' : `${coresN(avg)}→${coresN(peak)}`);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

async function main() {
  // guard: чужой тип конфига без .mjs → не лезем (иначе подмена .mjs сломает билд)
  if (OTHER_CFG && !HAS_MJS) {
    console.error(
      `✖ найден ${basename(OTHER_CFG)}, а тул поддерживает только next.config.mjs.\n` +
        `  Прерываю, чтобы не сломать твой билд. Сконвертируй конфиг в .mjs либо укажи --app= на приложение с .mjs.`
    );
    process.exit(1);
  }

  if (DRY) {
    console.log(
      `▶ DRY · app=${APP_REL} · mjs-конфиг=${HAS_MJS ? 'есть' : OTHER_CFG ? basename(OTHER_CFG) : 'нет'} · next-rspack=${HAS_RSPACK} · ws-pkgs=${WS_PKGS.length}`
    );
    backupConfig();
    installConfig('minimal');
    const okMin = readFileSync(CFG, 'utf8').includes('transpilePackages');
    installConfig('clean');
    const cleanSrc = readFileSync(CFG, 'utf8');
    const okClean =
      cleanSrc.includes('splitChunks') && cleanSrc.includes('[\\\\/]node_modules[\\\\/]');
    if (HAS_MJS) installConfig('custom');
    restoreConfig();
    const restored = HAS_MJS ? existsSync(CFG) : !existsSync(CFG);
    console.log(
      `  минимал=${okMin ? 'ok' : 'FAIL'} · clean=${okClean ? 'ok (regex цел)' : 'FAIL (escape!)'} · restore=${restored ? 'ok' : 'FAIL'}`
    );
    if (!HAS_MJS) console.log('  (нет next.config.mjs → custom пропускается; временный удаляется)');
    return;
  }

  let variants = ALL_VARIANTS.filter((v) => !ONLY || ONLY.includes(v.id));
  const skipped = [];
  variants = variants.filter((v) => {
    if (v.needs === 'rspack' && !HAS_RSPACK) {
      skipped.push(`${v.id} (нет next-rspack)`);
      return false;
    }
    if (v.needsConfig && !HAS_CONFIG) {
      skipped.push(`${v.id} (нет next.config.mjs)`);
      return false;
    }
    return true;
  });

  console.log(`\n▶ bench-build · app=${APP_REL} · ядер: ${NCORES} · raw next build · серийно`);
  console.log(
    `  варианты: ${variants.map((v) => v.id).join(', ')}${skipped.length ? ` · пропущены: ${skipped.join(', ')}` : ''}`
  );
  console.log(
    `  изолированный ${DIST} (рабочий .next цел) · CPU=avg→peak ядер · вес=RAW (без пост-обработки)\n`
  );
  if (!variants.length) {
    console.log('  нечего запускать.');
    return;
  }

  const rows = [];
  backupConfig(); // no-op если своего .mjs нет
  try {
    for (const v of variants) {
      installConfig(v.config); // minimal/clean пишем всегда (нужна distDir-изоляция); custom — только при HAS_CONFIG
      process.stdout.write(`  [${v.id}] cold… `);
      const cold = await runBuild(v, true);
      const w = bundleWeight();
      let hot = { ms: 0, peakRam: 0, avgCpu: -1, peakCpu: -1, failed: '' };
      if (!COLD_ONLY && !cold.failed) {
        process.stdout.write('hot… ');
        hot = await runBuild(v, false);
      }
      if (cold.failed)
        console.log(
          `❌ ${cold.failed} — ${cold.tail.split('\n').filter(Boolean).slice(-1)[0] ?? ''}`
        );
      else
        console.log(
          `cold ${fmt(cold.ms)} · hot ${fmt(hot.ms)} · RAM ${ram(Math.max(cold.peakRam, hot.peakRam))} · CPU ${cpuCell(cold.avgCpu, cold.peakCpu)} ядер · ${Math.round(w.totalMB * 1024)}KB`
        );
      rows.push({ id: v.id, cold, hot, w });
    }
  } finally {
    restoreConfig();
    console.log(`\n  (next.config.mjs ${HAS_MJS ? 'восстановлен' : 'временный удалён'})`);
  }

  printTable(rows);
  if (MD) printMarkdown(rows);
}

function printTable(rows) {
  console.log(`\n${'═'.repeat(92)}`);
  console.log(
    `${pad('ВАРИАНТ', 15)}${padL('COLD', 8)}${padL('HOT', 8)}${padL('RAM', 9)}${padL('CPU ядер', 14)}${padL('ВЕС', 9)}  ТОП-3`
  );
  console.log('─'.repeat(92));
  for (const r of rows) {
    if (r.cold.failed) {
      console.log(`${pad(r.id, 15)}  ❌ ${r.cold.failed}`);
      continue;
    }
    const top3 = r.w.top.map((t) => `${t.kb}KB`).join('/');
    console.log(
      `${pad(r.id, 15)}${padL(fmt(r.cold.ms), 8)}${padL(fmt(r.hot.ms), 8)}${padL(ram(Math.max(r.cold.peakRam, r.hot.peakRam)), 9)}${padL(cpuCell(r.cold.avgCpu, r.cold.peakCpu), 14)}${padL(`${Math.round(r.w.totalMB * 1024)}KB`, 9)}  ${top3 || '—'}`
    );
  }
  console.log('═'.repeat(92));
}

function printMarkdown(rows) {
  console.log('\n— markdown для статьи —\n');
  console.log(`| вариант | cold | hot | пик RAM | CPU avg→peak (из ${NCORES}) | вес raw | топ-3 |`);
  console.log('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    if (r.cold.failed) {
      console.log(`| ${r.id} | ❌ ${r.cold.failed} | | | | | |`);
      continue;
    }
    const top3 = r.w.top.map((t) => `${t.kb}KB`).join(' / ');
    console.log(
      `| ${r.id} | ${fmt(r.cold.ms)} | ${fmt(r.hot.ms)} | ${ram(Math.max(r.cold.peakRam, r.hot.peakRam))} | ${cpuCell(r.cold.avgCpu, r.cold.peakCpu)} | ${Math.round(r.w.totalMB * 1024)}KB | ${top3 || '—'} |`
    );
  }
  console.log(
    '\n_Методика: raw `next build` (без пре/пост-цепочки), изолированный distDir, строго серийно. ' +
      'turbopack игнорирует webpack-конфиг (его clean/custom = дефолт). Вес — RAW, без mangle/compress. ' +
      'CPU avg занижен серийными фазами Next — смотрите peak._'
  );
}

main().catch((e) => {
  restoreConfig();
  console.error('bench-build fail (конфиг восстановлен):', e);
  process.exit(1);
});
