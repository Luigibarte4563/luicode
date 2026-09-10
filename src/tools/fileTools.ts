import { diffEngine } from '../diff/DiffEngine';
import { Tool, ToolRuntime } from './registry';

function str(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function pathArg(args: Record<string, unknown>): string {
  const p = args.path ?? args.file ?? args.from;
  if (!p) throw new Error('Missing "path" argument');
  return str(p);
}

export const fileTools: Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace. Args: { path }',
    async run(args, rt) {
      const rel = pathArg(args);
      const content = rt.ws.readFile(rel);
      const max = typeof args.maxLines === 'number' ? (args.maxLines as number) : 400;
      const lines = content.split('\n');
      const shown = lines.slice(0, max);
      const suffix = lines.length > max ? `\n… (${lines.length - max} more lines)` : '';
      return `FILE ${rel} (${lines.length} lines)\n---\n${shown.join('\n')}${suffix}`;
    }
  },
  {
    name: 'create_file',
    description: 'Create a new file with content. Args: { path, content }',
    async run(args, rt) {
      const rel = pathArg(args);
      const content = str(args.content ?? '');
      const perm = rt.permission.canWrite(rel);
      if (!perm.allowed) return `DENIED: ${perm.reason}`;
      if (rt.ws.absoluteExists(rt.ws.resolveSafe(rel) ?? '')) return `ERROR: file already exists: ${rel}`;
      rt.ws.writeFile(rel, content);
      return `CREATED ${rel} (${Buffer.byteLength(content, 'utf8')} bytes)`;
    }
  },
  {
    name: 'write_file',
    description: 'Overwrite a file with new content. Args: { path, content }',
    async run(args, rt) {
      const rel = pathArg(args);
      const content = str(args.content ?? '');
      const oldContent = rt.ws.absoluteExists(rt.ws.resolveSafe(rel) ?? '') ? rt.ws.readFileSafe(rel) : '';
      const perm = rt.permission.canWrite(rel);
      if (!perm.allowed) return `DENIED: ${perm.reason}`;
      rt.ws.writeFile(rel, content);
      const d = diffEngine.compute(oldContent, content);
      return `WROTE ${rel} (${Buffer.byteLength(content, 'utf8')} bytes). Changes: +${d.additions} -${d.deletions}`;
    }
  },
  {
    name: 'edit_file',
    description: 'Replace an exact string in a file. Args: { path, find, replace }',
    async run(args, rt) {
      const rel = pathArg(args);
      const find = str(args.find);
      const replace = str(args.replace ?? '');
      if (!find) return 'ERROR: missing "find" argument';
      const content = rt.ws.readFile(rel);
      const idx = content.indexOf(find);
      if (idx < 0) return `ERROR: string not found in ${rel}`;
      const updated = content.slice(0, idx) + replace + content.slice(idx + find.length);
      const perm = rt.permission.canWrite(rel);
      if (!perm.allowed) return `DENIED: ${perm.reason}`;
      rt.ws.writeFile(rel, updated);
      return `EDITED ${rel}: replaced ${find.length} chars with ${replace.length} chars`;
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file. Args: { path }',
    async run(args, rt) {
      const rel = pathArg(args);
      const perm = rt.permission.canDelete(rel);
      if (!perm.requiresApproval && !perm.allowed) return `DENIED: ${perm.reason}`;
      rt.ws.deleteFile(rel);
      return `DELETED ${rel}`;
    }
  },
  {
    name: 'rename_file',
    description: 'Rename/move a file. Args: { from, to }',
    async run(args, rt) {
      const from = str(args.from ?? args.path);
      const to = str(args.to);
      if (!from || !to) return 'ERROR: need "from" and "to"';
      const permAuthor = rt.permission.canDelete(from);
      const permTarget = rt.permission.canWrite(to);
      if (!permAuthor.allowed || !permTarget.allowed) return `DENIED: ${permAuthor.reason || permTarget.reason}`;
      rt.ws.renameFile(from, to);
      return `RENAMED ${from} → ${to}`;
    }
  },
  {
    name: 'list_directory',
    description: 'List directory contents. Args: { path? }',
    async run(args, rt) {
      const rel = str(args.path ?? '.');
      const entries = rt.ws.listDirectory(rel === '.' ? '' : rel);
      return `DIR ${rel}\n${entries.length ? entries.join('\n') : '(empty)'}`;
    }
  },
  {
    name: 'search_files',
    description: 'Find files by glob pattern. Args: { pattern }',
    async run(args, rt) {
      const pattern = str(args.pattern ?? '*.ts');
      const matches = rt.ws.searchFiles(pattern);
      return `MATCHES ${matches.length}\n${matches.join('\n')}`;
    }
  },
  {
    name: 'search_code',
    description: 'Search source code for a string. Args: { query, maxResults? }',
    async run(args, rt) {
      const query = str(args.query);
      const max = typeof args.maxResults === 'number' ? (args.maxResults as number) : 40;
      const hits = rt.ws.searchCode(query, max);
      if (!hits.length) return `NO_MATCHES for "${query}"`;
      return hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join('\n');
    }
  },
  {
    name: 'read_project_tree',
    description: 'Show the project file tree (top 4 levels). Args: {}',
    async run(_args, rt) {
      return rt.ws.tree('.', 4);
    }
  }
];