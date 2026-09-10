import * as fs from 'fs';
import * as path from 'path';
import { Workspace } from './Workspace';

export interface ProjectProfile {
  name: string;
  language: string;
  framework: string;
  bundler: string;
  database: string;
  testFramework: string;
  packageManager: string;
  entryFiles: string[];
  manifest?: Record<string, unknown>;
  keyFiles: string[];
  staticWeb?: boolean;
}

const LANG_EXT: Array<[string, RegExp]> = [
  ['TypeScript', /\.(ts|tsx)$/i],
  ['JavaScript', /\.(js|jsx|mjs|cjs)$/i],
  ['Python', /\.py$/i],
  ['Go', /\.go$/i],
  ['Rust', /\.rs$/i],
  ['Java', /\.java$/i],
  ['C#', /\.cs$/i],
  ['Ruby', /\.rb$/i],
  ['PHP', /\.php$/i],
  ['C/C++', /\.(c|cc|cpp|h|hpp)$/i]
];

function detectFramework(pkg: Record<string, unknown>): string {
  const deps: string[] = Object.keys((pkg.dependencies as Record<string, unknown>) ?? {});
  const dev: string[] = Object.keys((pkg.devDependencies as Record<string, unknown>) ?? {});
  const all = [...deps, ...dev].join(' ');
  const exts = all.toLowerCase();
  if (exts.includes('next')) return 'Next.js';
  if (exts.includes('nuxt')) return 'Nuxt';
  if (exts.includes('react')) return 'React';
  if (exts.includes('vue')) return 'Vue';
  if (exts.includes('svelte')) return 'Svelte';
  if (exts.includes('express')) return 'Express';
  if (exts.includes('fastify')) return 'Fastify';
  if (exts.includes('django')) return 'Django';
  if (exts.includes('flask')) return 'Flask';
  if (exts.includes('fastapi')) return 'FastAPI';
  if (exts.includes('spring')) return 'Spring';
  if (exts.includes('gorilla')) return 'Gin';
  return 'Unknown';
}

function detectBundler(pkg: Record<string, unknown>): string {
  const scripts = JSON.stringify(pkg.scripts ?? {});
  const dev = Object.keys((pkg.devDependencies as Record<string, unknown>) ?? {}).join(' ');
  if (dev.includes('vite')) return 'Vite';
  if (dev.includes('webpack')) return 'Webpack';
  if (scripts.includes('tsc')) return 'tsc';
  if (dev.includes('esbuild')) return 'esbuild';
  if (dev.includes('rollup')) return 'Rollup';
  return 'npm';
}

function detectDatabase(files: string[]): string {
  const names = files.map((f) => f.toLowerCase()).join(' ');
  if (names.includes('prisma/schema')) return 'Prisma+PostgreSQL';
  if (names.includes('drizzle')) return 'Drizzle';
  if (names.includes('.sqlite')) return 'SQLite';
  if (names.includes('migrations')) return 'Migrations (SQL)';
  return 'Unknown';
}

function detectTestFramework(pkg: Record<string, unknown>): string {
  const dev = Object.keys((pkg.devDependencies as Record<string, unknown>) ?? {}).join(' ');
  const scripts = JSON.stringify(pkg.scripts ?? {});
  const low = (dev + ' ' + scripts).toLowerCase();
  if (low.includes('jest')) return 'Jest';
  if (low.includes('vitest')) return 'Vitest';
  if (low.includes('mocha')) return 'Mocha';
  if (low.includes('pytest')) return 'pytest';
  if (low.includes('go test')) return 'go test';
  if (low.includes('cargo test')) return 'cargo test';
  return 'Unknown';
}

function detectPackageManager(): string {
  if (fs.existsSync(path.join(process.cwd(), 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(process.cwd(), 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(process.cwd(), 'package-lock.json'))) return 'npm';
  return 'npm';
}

export function inspectProject(ws: Workspace): ProjectProfile {
  const files = ws.walkFiles();
  const pkgPath = files.find((f) => f.endsWith('package.json'));
  let pkg: Record<string, unknown> | undefined;
  if (pkgPath && ws.absoluteExists(path.join(ws.root, pkgPath))) {
    try {
      pkg = JSON.parse(ws.readFile(pkgPath)) as Record<string, unknown>;
    } catch {
      pkg = undefined;
    }
  }

  const extCounts: Record<string, number> = {};
  for (const f of files) {
    const m = path.extname(f);
    if (m) extCounts[m] = (extCounts[m] ?? 0) + 1;
  }
  let language = 'Unknown';
  let best = 0;
  for (const [name, rx] of LANG_EXT) {
    const count = Object.entries(extCounts)
      .filter(([ext]) => rx.test(ext))
      .reduce((s, [, c]) => s + c, 0);
    if (count > best) {
      best = count;
      language = name;
    }
  }

  const entryCandidates = [
    'src/main.ts',
    'src/index.ts',
    'src/App.tsx',
    'src/main.tsx',
    'index.ts',
    'index.js',
    'index.html',
    'main.py',
    'main.go',
    'src/main.rs'
  ];
  const entryFiles = entryCandidates.filter((c) => files.includes(c)).slice(0, 3);

  const keyFiles = [
    'package.json',
    'tsconfig.json',
    'README.md',
    'index.html',
    'requirements.txt',
    'pyproject.toml',
    'go.mod',
    'Cargo.toml',
    '.env.example',
    'prisma/schema.prisma',
    'docker-compose.yml'
  ].filter((k) => files.includes(k));

  const detectedFramework = pkg ? detectFramework(pkg) : 'Unknown';
  const hasIndexHtml = files.includes('index.html');
  const isVanilla = Boolean(hasIndexHtml && (!pkg || detectedFramework === 'Unknown'));

  const profile: ProjectProfile = {
    name: ws.root.split(path.sep).filter(Boolean).pop() ?? 'project',
    language: isVanilla ? 'HTML/CSS/JS' : language,
    framework: isVanilla ? 'Vanilla' : 'Unknown',
    bundler: pkg ? detectBundler(pkg) : isVanilla ? 'None' : 'Unknown',
    database: detectDatabase(files),
    testFramework: pkg ? detectTestFramework(pkg) : 'Unknown',
    packageManager: detectPackageManager(),
    entryFiles,
    manifest: pkg,
    keyFiles,
    staticWeb: isVanilla
  };
  if (!isVanilla && pkg) profile.framework = detectFramework(pkg);
  return profile;
}