import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validateBody } from '../middleware/zodValidation.js';
import { nvidiaController } from '../controllers/NvidiaController.js';

const router = Router();

const analysisSchema = z.object({
  image: z.string().optional(),
  imagePath: z.string().optional(),
  eventId: z.string().optional(),
  useStoredImage: z.boolean().optional(),
  includeAnnotatedImage: z.boolean().optional(),
});

router.post('/analyze', authenticate(), validateBody(analysisSchema), (req, res) =>
  nvidiaController.analyze(req, res),
);
router.post('/analyze-event', authenticate(), validateBody(analysisSchema), (req, res) =>
  nvidiaController.analyzeEvent(req, res),
);
router.get('/event-analysis/:eventId', authenticate(), (req, res) =>
  nvidiaController.getEventAnalysis(req, res),
);
router.get('/health', (req, res) => nvidiaController.health(req, res));
router.post(
  '/assess-threat',
  authenticate(),
  validateBody(
    z.object({
      state: z.string().optional(),
      eventId: z.string().optional(),
    }),
  ),
  (req, res) => nvidiaController.assessThreatHandler(req, res),
);
router.get('/results', authenticate(), (req, res) => nvidiaController.getResults(req, res));
router.get('/models', authenticate(), (req, res) => nvidiaController.getModels(req, res));
router.put('/config', authenticate({ roles: ['admin'] }), (req, res) =>
  nvidiaController.updateConfig(req, res),
);
router.post('/analyze-with-bboxes', authenticate(), validateBody(analysisSchema), (req, res) =>
  nvidiaController.analyzeWithBboxes(req, res),
);
router.post('/analyze-persons', authenticate(), validateBody(analysisSchema), (req, res) =>
  nvidiaController.analyzePersons(req, res),
);
router.post(
  '/analyze-event-with-bboxes',
  authenticate(),
  validateBody(analysisSchema),
  (req, res) => nvidiaController.analyzeEventWithBboxes(req, res),
);

export default router;
