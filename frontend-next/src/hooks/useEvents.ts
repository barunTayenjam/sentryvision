import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { eventService } from '@/services/api/eventService';
import { mapEnhancedEvent } from '@/lib/mapEnhancedEvent';
import { MotionEvent } from '@/types/security';

export function useEvents(limit?: number) {
  return useQuery({
    queryKey: ['events', limit],
    queryFn: () => eventService.getEnhancedEventsList({ limit }),
    staleTime: 10_000,
  });
}

export interface EventsListParams {
  page?: number;
  pageSize?: number;
  camera_id?: string;
  event_type?: string;
  min_confidence?: number;
  start_date?: string;
  end_date?: string;
  sortBy?: string;
}

export interface EventsListResult {
  events: MotionEvent[];
  totalPages: number;
}

export function useEventsList(params: EventsListParams) {
  return useQuery<EventsListResult>({
    queryKey: ['events', 'list', params],
    queryFn: async () => {
      const response = await eventService.getEnhancedEventsList(params);
      const events: MotionEvent[] = response.events.map(mapEnhancedEvent);
      return { events, totalPages: response.pagination?.totalPages ?? 1 };
    },
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
}

export function useMotionEvents(limit?: number) {
  return useQuery({
    queryKey: ['motionEvents', limit],
    queryFn: () => eventService.getMotionEvents(limit),
    staleTime: 10_000,
  });
}

export function useSemanticEvents(
  query: string,
  options?: { cameraId?: string; eventType?: string; limit?: number },
) {
  return useQuery({
    queryKey: ['events', 'semantic', query, options],
    queryFn: async () => {
      const response = await eventService.semanticSearch(query, options);
      const events: MotionEvent[] = response.events.map((e) => mapEnhancedEvent(e));
      return {
        events,
        total: response.total,
        semanticHits: response.semanticHits,
        keywordHits: response.keywordHits,
      };
    },
    enabled: !!query,
    staleTime: 30_000,
  });
}

export function useCalendarStats(year: number, month: number, cameraId?: string) {
  return useQuery({
    queryKey: ['calendarStats', year, month, cameraId],
    queryFn: () => eventService.getCalendarStats(year, month, cameraId),
    staleTime: 60_000,
    enabled: !!year && !!month,
  });
}

export function useArchiveEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => eventService.archiveEvent(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['events'] });
      queryClient.invalidateQueries({ queryKey: ['motionEvents'] });
    },
  });
}
