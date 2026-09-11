import { ProjectProfile } from '../workspace/inspector';
import { AdapterOverrideConfig } from '../types';

export interface Adapter {
  name: string;
  detect: string;
  configFile: string;
  scaffold: string;
  install: string;
  installOne: string;
  test: string;
  build?: string;
  lockfile?: string;
  verify: string;
  registry: string;
  scriptSuppressed: boolean;
}

export const ADAPTERS: Adapter[] = [
  {
    name: 'node-npm',
    detect: 'package.json with package-lock.json',
    configFile: 'package.json',
    scaffold: 'npm init -y',
    install: 'npm install --ignore-scripts',
    installOne: 'npm install --ignore-scripts {package}',
    test: 'npm test',
    build: 'npm run build',
    lockfile: 'package-lock.json',
    verify: 'npm ls --depth=0',
    registry: 'npmjs.org',
    scriptSuppressed: true
  },
  {
    name: 'node-pnpm',
    detect: 'package.json with pnpm-lock.yaml',
    configFile: 'package.json',
    scaffold: 'pnpm init',
    install: 'pnpm install --ignore-scripts',
    installOne: 'pnpm add {package}',
    test: 'pnpm test',
    build: 'pnpm build',
    lockfile: 'pnpm-lock.yaml',
    verify: 'pnpm list --depth=0',
    registry: 'npmjs.org',
    scriptSuppressed: true
  },
  {
    name: 'node-yarn',
    detect: 'package.json with yarn.lock',
    configFile: 'package.json',
    scaffold: 'yarn init -y',
    install: 'yarn install --ignore-scripts',
    installOne: 'yarn add {package}',
    test: 'yarn test',
    build: 'yarn build',
    lockfile: 'yarn.lock',
    verify: 'yarn list --depth=0',
    registry: 'npmjs.org',
    scriptSuppressed: true
  },
  {
    name: 'python-pip',
    detect: 'requirements.txt (or setup.py / setup.cfg)',
    configFile: 'requirements.txt',
    scaffold: 'pip install --upgrade setuptools wheel',
    install: 'pip install -r requirements.txt',
    installOne: 'pip install {package}',
    test: 'python -m pytest',
    lockfile: 'requirements.txt',
    verify: 'pip freeze',
    registry: 'PyPI (pypi.org)',
    scriptSuppressed: false
  },
  {
    name: 'python-poetry',
    detect: 'pyproject.toml with poetry.lock',
    configFile: 'pyproject.toml',
    scaffold: 'poetry new .',
    install: 'poetry install',
    installOne: 'poetry add {package}',
    test: 'poetry run pytest',
    build: 'poetry build',
    lockfile: 'poetry.lock',
    verify: 'poetry show',
    registry: 'PyPI (pypi.org)',
    scriptSuppressed: false
  },
  {
    name: 'rust-cargo',
    detect: 'Cargo.toml with Cargo.lock',
    configFile: 'Cargo.toml',
    scaffold: 'cargo init',
    install: 'cargo build',
    installOne: 'cargo add {package}',
    test: 'cargo test',
    build: 'cargo build --release',
    lockfile: 'Cargo.lock',
    verify: 'cargo tree -e normal',
    registry: 'crates.io',
    scriptSuppressed: false
  },
  {
    name: 'go-modules',
    detect: 'go.mod with go.sum',
    configFile: 'go.mod',
    scaffold: 'go mod init <module>',
    install: 'go mod download',
    installOne: 'go get {package}',
    test: 'go test ./...',
    build: 'go build ./...',
    lockfile: 'go.sum',
    verify: 'go list -m all',
    registry: 'proxy.golang.org',
    scriptSuppressed: false
  },
  {
    name: 'ruby-bundler',
    detect: 'Gemfile with Gemfile.lock',
    configFile: 'Gemfile',
    scaffold: 'bundle init',
    install: 'bundle install',
    installOne: 'bundle add {package}',
    test: 'bundle exec rspec',
    lockfile: 'Gemfile.lock',
    verify: 'bundle list',
    registry: 'rubygems.org',
    scriptSuppressed: false
  }
];

export function adapterNamed(name: string): Adapter | undefined {
  return ADAPTERS.find((a) => a.name === name);
}

export function adapterForProfile(profile: ProjectProfile, overrides?: Record<string, AdapterOverrideConfig>): Adapter | null {
  const pool = overrides ? resolveAdapters(overrides) : ADAPTERS;
  const key = profile.keyFiles.join(' ');
  if (key.includes('package.json')) {
    if (key.includes('pnpm-lock.yaml')) return pool.find((a) => a.name === 'node-pnpm') ?? null;
    if (key.includes('yarn.lock')) return pool.find((a) => a.name === 'node-yarn') ?? null;
    return pool.find((a) => a.name === 'node-npm') ?? null;
  }
  if (key.includes('Cargo.toml')) return pool.find((a) => a.name === 'rust-cargo') ?? null;
  if (key.includes('go.mod')) return pool.find((a) => a.name === 'go-modules') ?? null;
  if (key.includes('pyproject.toml')) return pool.find((a) => a.name === 'python-poetry') ?? null;
  if (key.includes('requirements.txt')) return pool.find((a) => a.name === 'python-pip') ?? null;
  if (key.includes('Gemfile')) return pool.find((a) => a.name === 'ruby-bundler') ?? null;
  return null;
}

export function resolveAdapters(overrides?: Record<string, AdapterOverrideConfig>): Adapter[] {
  return ADAPTERS.map((a) => {
    const o = overrides?.[a.name];
    if (!o) return a;
    return { ...a, ...o };
  });
}

export function adaptersContext(overrides?: Record<string, AdapterOverrideConfig>): string {
  const lines = resolveAdapters(overrides).map((a) => {
    const build = a.build ? `build: ${a.build}` : 'build: (none)';
    return `- ${a.name}: detect ${a.detect} | scaffold: ${a.scaffold} | install: ${a.install} | installOne: ${a.installOne.replace('{package}', '{package}')} | test: ${a.test} | ${build} | lockfile: ${a.lockfile ?? '(none)'} | verify: ${a.verify} | registry: ${a.registry} | script-suppressed: ${a.scriptSuppressed}`;
  });
  return lines.join('\n');
}