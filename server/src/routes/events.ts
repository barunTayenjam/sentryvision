import { Router } from 'express';
import { eventController } from '../controllers/EventController.js';
import { optionalAuth } from '../middleware/auth.js';

const router = Router();

router.get('/list-enhanced', optionalAuth, (req, res) => eventController.listEnhanced(req, res));
router.get('/:id/relations', optionalAuth, (req, res) => eventController.getEventRelations(req, res));
router.get('/:id/relation-threat', optionalAuth, (req, res) =>
  eventController.getEventRelationThreat(req, res),
);

router.patch('/:id/feedback', optionalAuth, (req, res) =>
  eventController.setFeedback(req, res),
);

export default router;
