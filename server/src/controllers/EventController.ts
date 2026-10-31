import { Request, Response } from 'express';
import { BaseController } from './BaseController.js';
import eventSearchService from '../services/eventSearchService.js';
import { relationAnalysisService } from '../services/relationAnalysisService.js';
import { relationThreatService } from '../services/relationThreatService.js';

export class EventController extends BaseController {
  async listEnhanced(req: Request, res: Response): Promise<void> {
    try {
      const filters = req.query as Record<string, string>;
      const result = await eventSearchService.listEnhanced(filters);
      this.ok(res, {
        events: result.events,
        pagination: result.pagination,
      });
    } catch (error) {
      this.serverError(res, error, 'listEnhanced');
    }
  }

  async getEventRelations(req: Request, res: Response): Promise<void> {
    try {
      const result = await relationAnalysisService.getEventRelations(req.params.id);
      if (!result) {
        this.notFound(res, 'Event not found');
        return;
      }
      this.ok(res, result as unknown as Record<string, unknown>);
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid event id') {
        this.badRequest(res, error.message);
        return;
      }
      this.serverError(res, error, 'getEventRelations');
    }
  }

  async getEventRelationThreat(req: Request, res: Response): Promise<void> {
    try {
      const result = await relationThreatService.assessEventThreat(req.params.id);
      if (!result) {
        this.notFound(res, 'Event not found');
        return;
      }
      this.ok(res, result as unknown as Record<string, unknown>);
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid event id') {
        this.badRequest(res, error.message);
        return;
      }
      this.serverError(res, error, 'getEventRelationThreat');
    }
  }

  async setFeedback(req: Request, res: Response): Promise<void> {
    try {
      const { feedback } = req.body as { feedback?: unknown };
      const VALID = ['false_positive', 'false_negative', 'confirmed'] as const;
      type Verdict = (typeof VALID)[number] | null;

      let verdict: Verdict;
      if (feedback === null) {
        verdict = null;
      } else if (
        typeof feedback === 'string' &&
        (VALID as readonly string[]).includes(feedback)
      ) {
        verdict = feedback as Verdict;
      } else {
        this.badRequest(res, `feedback must be one of ${VALID.join(' | ')} or null`);
        return;
      }

      const event = await eventSearchService.setEventFeedback(req.params.id, verdict);
      if (!event) {
        this.notFound(res, 'Event not found');
        return;
      }
      this.ok(res, {
        event: { id: event.id, user_feedback: event.user_feedback },
      });
    } catch (error) {
      this.serverError(res, error, 'setFeedback');
    }
  }
}

export const eventController = new EventController();
