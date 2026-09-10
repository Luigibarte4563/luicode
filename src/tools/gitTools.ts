import { Tool } from './registry';
import { GitManager } from '../git/GitManager';

export function gitTools(git: GitManager): Tool[] {
  return [
    {
      name: 'git_status',
      description: 'Show working tree status. Args: {}',
      async run() {
        const out = (await git.status()).trim();
        return out || '(working tree clean)';
      }
    },
    {
      name: 'git_diff',
      description: 'Show uncommitted diff summary. Args: {}',
      async run() {
        const out = (await git.diff()).trim();
        return out || '(no uncommitted changes)';
      }
    },
    {
      name: 'git_log',
      description: 'Show recent commit history. Args: { count? }',
      async run(args) {
        const count = typeof args.count === 'number' ? (args.count as number) : 10;
        return (await git.log(count)).trim() || '(no commits yet)';
      }
    },
    {
      name: 'git_branch',
      description: 'Show current branch. Args: {}',
      async run() {
        return (await git.branch()).trim();
      }
    }
  ];
}