import { Router } from 'express';
import { wrap } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { getPublished, studentModels, defaultModelId } from '../lib/companion.js';

/** Public (authenticated) view of the published companion: name, starters, models, depths. */
export const companionRouter = Router();
companionRouter.use(requireAuth);

companionRouter.get(
  '/',
  wrap((_req, res) => {
    const cfg = getPublished();
    res.json({
      name: cfg.name,
      description: cfg.description,
      starters: cfg.starters,
      models: studentModels(cfg),
      defaultModelId: defaultModelId(cfg),
      depths: Object.fromEntries(Object.entries(cfg.depth).map(([k, v]) => [k, v.label])),
      version: cfg.versionNumber,
    });
  }),
);
