import express = require('express');
import http = require('http');
import path = require('path');
import { Workspace } from '../workspace/Workspace';
import { inspectProject } from '../workspace/inspector';
import { ModelRouter } from '../router/ModelRouter';
import { TASK_KINDS } from '../llm/integration';
import { TaskKind, LuicodeConfig } from '../types';
import { SessionManager } from '../sessions/SessionManager';
import { GitManager } from '../git/GitManager';

export interface ServerOptions {
  port: number;
  workspace: Workspace;
  config: LuicodeConfig;
  sessions: SessionManager;
  gitManager: GitManager;
}

export class LuicodeServer {
  private app: express.Express;
  private server: http.Server;
  private port: number;
  private workspace: Workspace;
  private config: LuicodeConfig;
  private readonly sessions: SessionManager;
  private readonly gitManager: GitManager;
  private modelRouter: Map<TaskKind, ModelRouter>;

  constructor(options: ServerOptions) {
    this.app = express();
    this.server = http.createServer(this.app);
    this.port = options.port;
    this.workspace = options.workspace;
    this.config = options.config;
    this.sessions = options.sessions;
    this.gitManager = options.gitManager;
    this.modelRouter = new Map();

    // Initialize model routers for each task kind
    TASK_KINDS.forEach((task) => {
      this.modelRouter.set(task, new ModelRouter(this.config));
    });

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    // Get __dirname for CommonJS compatibility
    const __dirname = path.resolve();
    const publicDir = path.join(__dirname, 'src', 'server', '..', '..', 'public');

    // Serve static files
    this.app.use(express.static(publicDir));

    // Body parsing middleware
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // Error handling middleware
    this.app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof Error) {
        console.error(err.stack);
      } else {
        console.error('Unknown error:', err);
      }
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  private setupRoutes() {
    // API Routes
    this.app.get('/api/status', (_req: express.Request, res: express.Response) => {
      res.json({
        status: 'running',
        workspace: this.workspace.root,
        timestamp: new Date().toISOString()
      });
    });

    this.app.get('/api/project', (_req: express.Request, res: express.Response) => {
      try {
        const profile = inspectProject(this.workspace);
        res.json(profile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    });

    this.app.get('/api/config', (_req: express.Request, res: express.Response) => {
      res.json(this.config);
    });

    this.app.get('/api/providers', (_req: express.Request, res: express.Response) => {
      // Placeholder for providers endpoint
      res.json({});
    });

    this.app.get('/api/models', (_req: express.Request, res: express.Response) => {
      const models: Record<string, string> = {};
      TASK_KINDS.forEach((task) => {
        const router = this.modelRouter.get(task);
        if (router) {
          try {
            const spec = router.specFor(task);
            models[task] = spec || 'none';
          } catch (e) {
            models[task] = 'error';
          }
        }
      });
      res.json(models);
    });

    this.app.post('/api/models/:task', (_req: express.Request, res: express.Response) => {
      const taskParam = _req.params.task;
      const { modelSpec } = _req.body;

      // Validate task parameter
      if (!TASK_KINDS.includes(taskParam as TaskKind)) {
        return res.status(400).json({ error: 'Invalid task' });
      }

      const task = taskParam as TaskKind;

      try {
        const router = this.modelRouter.get(task);
        if (router) {
          // In a real implementation, we would update the config
          // For now, just return success
          res.json({ success: true, model: modelSpec });
        } else {
          res.status(500).json({ error: 'Router not found' });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    });

    this.app.get('/api/sessions', (_req: express.Request, res: express.Response) => {
      // Placeholder for sessions endpoint
      res.json({});
    });

    this.app.get('/api/files', (_req: express.Request, res: express.Response) => {
      try {
        const files = this.workspace.walkFiles();
        res.json({ files });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    });

    this.app.get('/api/git/status', async (_req: express.Request, res: express.Response) => {
      try {
        const status = await this.gitManager.status();
        res.json({ status });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
      }
    });

    // Serve the main HTML file for all other routes (SPA behavior)
    this.app.get('*', (_req: express.Request, res: express.Response) => {
      const __dirname = path.resolve();
      const indexPath = path.join(__dirname, 'src', 'server', '..', '..', 'public', 'index.html');
      res.sendFile(indexPath);
    });
  }

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        console.log(`LUICode Server running at http://localhost:${this.port}`);
        resolve();
      }).on('error', (err: Error) => {
        reject(err);
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err: Error | undefined) => {
        if (err !== undefined) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}