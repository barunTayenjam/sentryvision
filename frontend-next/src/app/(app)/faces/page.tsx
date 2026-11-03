import { useEventsList } from '@/hooks/useEvents';

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useUrlSearchParams } from '@/hooks/useUrlSearchParams';
import { useToast } from '@/hooks/use-toast';
import { useCameraStore } from '@/stores/camera';
import { eventService } from '@/services/api/eventService';
import { cn } from '@/lib/utils';
import { Calendar, Search, X, Camera, ChevronLeft, ChevronRight, FaceSmile, User } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
} from '@/components/ui/pagination';

type SortOption = 'newest' | 'oldest' | 'confidence';

function getFilterFromParams(params: URLSearchParams): FilterState {
  return {
    cameraId: params.get('cameraId') || 'all',
    detectionType: (params.get('detectionType') || 'face') as FilterState['detectionType'],
    quickRange: (params.get('quickRange') || 'all') as FilterState['quickRange'],
    jevUrgent: (params.get('jev_urgent') || 'all') as FilterState['jevUrgent'],
    dateRange: {
      start: params.get('startDate') ? new Date(params.get('startDate')!) : undefined,
      end: params.get('endDate') ? new Date(params.get('endDate')!) : undefined,
    },
  };
}

interface FilterState {
  cameraId: string;
  detectionType: 'all' | 'motion' | 'person' | 'face' | 'vehicle';
  dateRange: { start: Date | undefined; end: Date | undefined };
  quickRange: 'all' | 'today' | 'yesterday' | 'last7days' | 'last30days';
  jevUrgent?: 'all' | 'true' | 'false';
}

interface FaceDetectionData {
  confidence: number;
  boundingBox?: number[];
  personId?: string;
  personName?: string;
  isKnown?: boolean;
}

interface EnhancedEvent {
  id: string;
  event_type: string;
  filename: string;
  timestamp: string;
  cameraId: string;
  cameraName?: string;
  confidence: number;
  metadata: Record<string, unknown>;
  imageUrl: string;
  labels?: string[];
  severity?: 'alert' | 'detection' | 'info';
  persons_detected: number;
  faces_detected: number;
  known_faces_count: number;
  unknown_faces_count: number;
  object_detections: any[] | null;
  face_detections: FaceDetectionData[] | null;
}

interface EnhancedEventsResponse {
  success: boolean;
  events: EnhancedEvent[];
  pagination?: { totalEvents: number; totalPages: number; currentPage: number; pageSize: number };
}

type QuickRangeOption = {
  label: string;
  value: FilterState['quickRange'];
  getDates: () => { start: Date; end: Date };
};

function normalizeToISTBoundary(date: Date, type: 'start' | 'end'): Date {
  const d = new Date(date);
  d.setHours(
    type === 'start' ? 0 : 23,
    type === 'start' ? 0 : 59,
    type === 'start' ? 0 : 59,
    type === 'start' ? 0 : 999,
  );
  return d;
}

const quickRangeOptions: QuickRangeOption[] = [
  {
    label: 'All Time',
    value: 'all',
    getDates: () => ({ start: undefined as unknown as Date, end: undefined as unknown as Date }),
  },
  {
    label: 'Today',
    value: 'today',
    getDates: () => ({
      start: normalizeToISTBoundary(new Date(), 'start'),
      end: normalizeToISTBoundary(new Date(), 'end'),
    }),
  },
  {
    label: 'Yesterday',
    value: 'yesterday',
    getDates: () => {
      const yesterday = new Date(Date.now() - 86400000);
      return {
        start: normalizeToISTBoundary(yesterday, 'start'),
        end: normalizeToISTBoundary(yesterday, 'end'),
      };
    },
  },
  {
    label: 'Last 7 Days',
    value: 'last7days',
    getDates: () => {
      const start = normalizeToISTBoundary(new Date(Date.now() - 6 * 86400000), 'start');
      const end = normalizeToISTBoundary(new Date(), 'end');
      return { start, end };
    },
  },
  {
    label: 'Last 30 Days',
    value: 'last30days',
    getDates: () => {
      const start = normalizeToISTBoundary(new Date(Date.now() - 29 * 86400000), 'start');
      const end = normalizeToISTBoundary(new Date(), 'end');
      return { start, end };
    },
  },
];

export default function FacesGalleryPage() {
  const { toast } = useToast();
  const cameras = useCameraStore((state) => state.cameras);
  const searchParams = useUrlSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/';

  const [analyzingEventId, setAnalyzingEventId] = useState<string | null>(null);
  const [analysisByEvent, setAnalysisByEvent] = useState<Record<string, any>>({});
  const [relationsByEvent, setRelationsByEvent] = useState<Record<string, any>>({});
  const [threatByEvent, setThreatByEvent] = useState<Record<string, any>>({});

  const currentPage = Math.max(1, parseInt(searchParams.get('page') || '1') || 1);
  const sortBy = (searchParams.get('sortBy') || 'newest') as SortOption;
  const selectedEventId = searchParams.get('eventId');
  const filters = useMemo(() => getFilterFromParams(searchParams), [searchParams]);

  const { data: listData, isLoading: listLoading, isError: listError, refetch: refetchList } =
    useEventsList({
      page: currentPage,
      pageSize: 20,
      camera_id: filters.cameraId === 'all' ? undefined : filters.cameraId,
      event_type: filters.detectionType === 'all' ? undefined : filters.detectionType,
      start_date: filters.dateRange.start?.toISOString(),
      end_date: filters.dateRange.end?.toISOString(),
      jev_urgent:
        filters.jevUrgent !== undefined && filters.jevUrgent !== 'all'
          ? filters.jevUrgent === 'true'
          : undefined,
      sortBy,
    });

  const isLoading = listLoading;
  const isError = listError;
  const refetch = refetchList;
  const events = listData?.events ?? [];
  const totalPages = listData?.totalPages ?? 1;

  const selectedEvent = events.find((e) => e.id === selectedEventId) || null;

  // Filter events that have face detections
  const faceEvents = useMemo(() => {
    return events.filter((e: EnhancedEvent) => (e.face_detections?.length ?? 0) > 0);
  }, [events]);

  useEffect(() => {
    if (isError) toast({ title: 'Error', description: 'Failed to load events', variant: 'destructive' });
  }, [isError, toast]);

  const updateParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      Object.entries(updates).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const handleFiltersChange = useCallback(
    (f: FilterState) => {
      updateParams({
        cameraId: f.cameraId !== 'all' ? f.cameraId : null,
        detectionType: f.detectionType !== 'all' ? f.detectionType : null,
        quickRange: f.quickRange !== 'all' ? f.quickRange : null,
        startDate: f.quickRange === 'all' && f.dateRange.start ? f.dateRange.start.toISOString() : null,
        endDate: f.quickRange === 'all' && f.dateRange.end ? f.dateRange.end.toISOString() : null,
        jev_urgent: f.jevUrgent !== 'all' ? (f.jevUrgent ?? null) : null,
        page: null,
        eventId: null,
      });
    },
    [updateParams],
  );

  const handleSortChange = useCallback(
    (value: SortOption) => {
      updateParams({ sortBy: value !== 'newest' ? value : null, page: null });
    },
    [updateParams],
  );

  const handlePageChange = useCallback(
    (page: number) => {
      updateParams({ page: page > 1 ? String(page) : null, eventId: null });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [updateParams],
  );

  const handleEventSelect = useCallback(
    (eventId: string) => {
      updateParams({ eventId: eventId === selectedEventId ? null : eventId });
    },
    [updateParams, selectedEventId],
  );

  const cameraList = cameras.map((c) => ({ id: c.id, name: c.name }));

  // Get face identity label
  const getFaceLabel = (face: FaceDetectionData, event: EnhancedEvent): string => {
    if (face.isKnown && face.personName) return face.personName;
    if (face.personName && face.personName !== 'unknown') return face.personName;
    const known = event.known_faces_count ?? 0;
    if (known > 0) return 'known person';
    return 'unknown person';
  };

  // Get face confidence display
  const getFaceConfidence = (face: FaceDetectionData): string => {
    return `${Math.round(face.confidence * 100)}%`;
  };

  // Render face bounding boxes on image
  const renderFaceBoxes = (event: EnhancedEvent) => {
    const faces = event.face_detections ?? [];
    if (faces.length === 0) return null;

    return (
      <div className="absolute inset-0 pointer-events-none">
        {faces.map((face, idx) => {
          const bbox = face.boundingBox;
          if (!bbox || bbox.length !== 4) return null;
          const [x, y, w, h] = bbox;
          // Convert from image coordinates (0-640, 0-360) to percentage
          const left = (x / 640) * 100;
          const top = (y / 360) * 100;
          const width = (w / 640) * 100;
          const height = (h / 360) * 100;

          return (
            <div
              key={idx}
              className="absolute border-2 border-green-400 bg-green-400/10"
              style={{
                left: `${left}%`,
                top: `${top}%`,
                width: `${width}%`,
                height: `${height}%`,
              }}
              title={`${getFaceLabel(face, event)} ${getFaceConfidence(face)}`}
            >
              <div className="absolute -top-5 left-0 bg-green-400 text-black text-[9px] px-1 rounded whitespace-nowrap">
                {getFaceLabel(face, event)} {getFaceConfidence(face)}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <PageContainer width="full">
      <div className="mb-4 flex items-center justify-between gap-4 border-b border-white/[0.06] pb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[4px] border border-primary/20 bg-primary/10">
            <FaceSmile className="h-4.5 w-4.5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-[-0.03em] text-foreground">Faces Gallery</h1>
            <p className="text-sm text-muted-foreground">All events with face detections — identity A, B, C with bounding boxes</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {faceEvents.length} face event{faceEvents.length === 1 ? '' : 's'} of {events.length} total
          </span>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Filters */}
        <div className="mb-4 border-b border-white/[0.06] pb-3">
          <SmartFilters cameras={cameraList} filters={filters} onFiltersChange={handleFiltersChange} />
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="animate-pulse rounded-lg overflow-hidden bg-card border border-white/[0.10]">
                <div className="aspect-video bg-white/[0.04]" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              Failed to load events. <button onClick={() => refetch()} className="ml-2 text-primary underline">Retry</button>
            </div>
          </div>
        ) : faceEvents.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-muted-foreground">
              <FaceSmile className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg">No face events found</p>
              <p className="text-sm mt-1">Try widening the date range or switching to All Events.</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {faceEvents.map((event: EnhancedEvent) => {
              const faces = event.face_detections ?? [];
              return (
                <div
                  key={event.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selectedEventId === event.id}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleEventSelect(event.id);
                    }
                  }}
                  className={cn(
                    'rounded-lg cursor-pointer transition-[border-color,background-color] duration-200',
                    selectedEventId === event.id
                      ? 'border-2 border-primary/60 bg-card'
                      : 'border border-white/[0.10] hover:border-white/[0.16]',
                  )}
                  onClick={() => handleEventSelect(event.id)}
                >
                  {/* Image with Face Boxes */}
                  <div className="relative aspect-video bg-black overflow-hidden">
                    {event.imageUrl ? (
                      <img
                        src={event.imageUrl}
                        alt={`Face event on ${event.cameraName}`}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xs text-white/40">
                        No image
                      </div>
                    )}
                    {renderFaceBoxes(event)}

                    {/* Face count badge */}
                    {(event.faces_detected ?? 0) > 0 && (
                      <div className="absolute top-2 left-2 px-2 py-1 rounded bg-green-500/90 text-black text-xs font-medium flex items-center gap-1">
                        <FaceSmile className="h-3 w-3" />
                        {event.faces_detected} {event.faces_detected === 1 ? 'face' : 'faces'}
                      </div>
                    )}

                    {/* Confidence */}
                    <div className="absolute bottom-2 right-2 px-2 py-1 rounded bg-black/85 text-xs font-mono tabular-nums">
                      <span className={cn(
                        event.confidence >= 0.8 ? 'text-green-400' :
                        event.confidence >= 0.5 ? 'text-amber-400' : 'text-muted-foreground',
                      )}>
                        {(event.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>

                  {/* Info */}
                  <div className="p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-foreground/90 truncate">
                        {event.cameraName}
                      </p>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <User className="h-3 w-3" />
                        {faces.length} face{faces.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 font-mono tabular-nums">
                      {new Date(event.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {totalPages > 1 && (
          <div className="mt-8 flex justify-center">
            <Pagination>
              <PaginationContent className="gap-1">
                <PaginationItem>
                  <PaginationPrevious
                    onClick={currentPage === 1 ? undefined : () => handlePageChange(currentPage - 1)}
                    className={currentPage === 1 ? 'pointer-events-none opacity-40' : ''}
                  />
                </PaginationItem>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let page: number;
                  if (totalPages <= 7) page = i + 1;
                  else if (currentPage <= 4) page = i + 1;
                  else if (currentPage >= totalPages - 3) page = totalPages - 6 + i;
                  else page = currentPage - 3 + i;
                  return (
                    <PaginationItem key={page}>
                      <PaginationLink
                        onClick={() => handlePageChange(page)}
                        isActive={page === currentPage}
                      >
                        {page}
                      </PaginationLink>
                    </PaginationItem>
                  );
                })}
                <PaginationItem>
                  <PaginationNext
                    onClick={currentPage === totalPages ? undefined : () => handlePageChange(currentPage + 1)}
                    className={currentPage === totalPages ? 'pointer-events-none opacity-40' : ''}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        )}
      </div>
    </PageContainer>
  );
}

// Reuse the hook from EventsPage
import { useEventsList } from '@/hooks/useEvents';