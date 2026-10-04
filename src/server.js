import express from './runtime/express.js';
import { config } from './config.js';
import { createRouter } from './routes.js';
import { createLocalResponsesProviderRouter } from './http/localResponsesProviderRoutes.js';
import { createSetupGuideRouter } from './http/setupGuideRoutes.js';

export function createApp(bridge, fileStore, eventBus = null, turnManager = null, projectService = null, workflowManager = null) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: config.jsonBodyLimit }));
  // Mount the loopback-only Responses provider before the normal API token
  // middleware. Codex may attach unrelated account authorization headers even
  // when a custom provider requires no OpenAI auth; this provider ignores them
  // and accepts only local socket traffic.
  app.use(createLocalResponsesProviderRouter(bridge));
  // Serve the local setup guide before the legacy setup route so the browser
  // extension flow is explicit: configuration happens through the floating
  // B / Bridge control injected into a refreshed chatgpt.com conversation.
  app.use(createSetupGuideRouter(bridge));
  app.use(createRouter(bridge, fileStore, eventBus, turnManager, projectService, workflowManager));

  return app;
}
