'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useUrlSearchParams } from '@/hooks/useUrlSearchParams';
import { useToast } from '@/hooks/use-toast';
import { useCameraStore } from '@/stores/camera';
import { useEventsList } from '@/hooks/useEvents';
import { cn } from '@/lib/utils';
import { ScanFace, User } from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { SmartFilters, type FilterState } from '@/components/events/SmartFilters';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
} from '@/components/ui/pagination';

type SortOption = 'newest' | 'oldest' | 'confidence';

/** Auto-labels per event: A, B, C … for distinct persons, or identity name if recognized. */
const PERSON_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

interface PersonBox {
  bbox: { x: number; y: number; width: number; height: number };
  identity: string | null;
  confidence: number;
  humanVerified: boolean;
  letter: string;
  label: string;
}

interface MotionEvent {
  id: string;
  cameraId: string;
  cameraName?: string;
  timestamp: Date;
  imageUrl: string | null;
  confidence: number;
  labels?: string[];
  detections?: Array<{
    type: 'person' | 'face' | 'object';
    confidence: number;
    name?: string;
    isKnown?: boolean;
    class?: string;
    identity?: string | null;
    trackId?: number;
    trackletLen?: number | null;
    verificationTier?: string | null;
    humanVerified?: boolean;
    personAttributes?: Record<string, unknown> | null;
    boundingBox: { x: number; y: number; width: number; height: number };
  }>;
  personCount?: number;
  faceCount?: number;
  knownFaces?: number;
  unknownFaces?: number;
  severity?: 'alert' | 'detection' | 'info';
}

function getFilterFromParams(params: URLSearchParams): FilterState {
  return {
    cameraId: params.get('cameraId') || 'all',
    detectionType: (params.get('detectionType') || 'person') as FilterState['detectionType'],
    quickRange: (params.get('quickRange') || 'all') as FilterState['quickRange'],
    jevUrgent: (params.get('jev_urgent') || 'all') as FilterState['jevUrgent'],
    dateRange: {
      start: params.get('startDate') ? new Date(params.get('startDate')!) : undefined,
      end: params.get('endDate') ? new Date(params.get('endDate')!) : undefined,
    },
  };
}

/** Extract person boxes from mapped detections, assigning A/B/C labels per event.
 *  Recognized identities keep their name; unknowns get sequential letters. */
function extractPersonBoxes(event: MotionEvent): PersonBox[] {
  const dets = (event.detections ?? []).filter((d) => d.type === 'person' && d.boundingBox);
  const used = new Map<string, string>(); // identity → letter
  let letterIdx = 0;
  return dets.map((d) => {
    const identity = d.identity && d.identity !== 'unknown' && d.identity.trim() !== '' ? d.identity.trim() : null;
    let letter: string;
    if (identity) {
      letter = used.get(identity) ?? PERSON_LETTERS[letterIdx++ % 26];
      if (!used.has(identity)) used.set(identity, letter);
    } else {
      letter = PERSON_LETTERS[letterIdx++ % 26];
    }
    const bbox = d.boundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      bbox,
      identity,
      confidence: d.confidence ?? 0,
      humanVerified: !!d.humanVerified,
      letter,
      label: identity ?? `person ${letter}`,
    };
  });
}

export default function FacesGalleryPage() {
  const { toast } = useToast();
  const cameras = useCameraStore((state) => state.cameras);
  const searchParams = useUrlSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/';

  const currentPage = Math.max(1, parseInt(searchParams.get('page') || '1') || 1);
  const selectedEventId = searchParams.get('eventId');
  const filters = useMemo(() => getFilterFromParams(searchParams), [searchParams]);

  const { data: listData, isLoading, isError, refetch: refetchList } =
    useEventsList({
      page: currentPage,
      pageSize: 20,
      camera_id: filters.cameraId === 'all' ? undefined : filters.cameraId,
      event_type: filters.detectionType === 'all' ? undefined : filters.detectionType,
      start_date: filters.dateRange.start?.toISOString(),
      end_date: filters.dateRange.end?.toISOString(),
    });

  const events = listData?.events ?? [];
  const totalPages = listData?.totalPages ?? 1;

  // Person events: any event with at least one person detection (boxes present).
  const personEvents = useMemo(
    () => events.map((e) => ({ event: e, boxes: extractPersonBoxes(e) })).filter(({ boxes }) => boxes.length > 0),
    [events],
  );

  useEffect(() => {
    if (isError) {
      toast({ title: 'Error', description: 'Failed to load events', variant: 'destructive' });
    }
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
        page: null,
        eventId: null,
      });
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

  const renderPersonBoxes = (boxes: PersonBox[]) => {
    return (
      <div className="absolute inset-0 pointer-events-none">
        {boxes.map((p, idx) => {
          const b = p.bbox;
          const known = p.identity !== null;
          return (
            <div
              key={`p-${idx}`}
              className={cn(
                'absolute border-2',
                known
                  ? 'border-emerald-400 bg-emerald-400/10'
                  : p.humanVerified
                    ? 'border-green-400 bg-green-400/10'
                    : 'border-amber-400 bg-amber-400/5 border-dashed',
              )}
              style={{
                left: `${(b.x / 640) * 100}%`,
                top: `${(b.y / 360) * 100}%`,
                width: `${(b.width / 640) * 100}%`,
                height: `${(b.height / 360) * 100}%`,
              }}
              title={`${p.label} · ${Math.round(p.confidence)}%${p.humanVerified ? ' · verified' : ''}`}
            >
              <div
                className={cn(
                  'absolute -top-5 left-0 text-black text-[10px] font-semibold px-1.5 rounded whitespace-nowrap',
                  known ? 'bg-emerald-400' : p.humanVerified ? 'bg-green-400' : 'bg-amber-400',
                )}
              >
                {p.label} {Math.round(p.confidence)}%
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
            <ScanFace className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-[-0.03em] text-foreground">
              Persons & Faces Gallery
            </h1>
            <p className="text-sm text-muted-foreground">
              Bounding boxes per person — A, B, C until a face is enrolled and recognized
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded-sm border-2 border-dashed border-amber-400 bg-amber-400/10" />
            person (unverified)
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded-sm border-2 border-green-400 bg-green-400/10" />
            verified
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded-sm border-2 border-emerald-400 bg-emerald-400/10" />
            recognized
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded-sm border-2 border-sky-400 bg-sky-400/10" />
            face
          </span>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
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
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            Failed to load events.
            <button onClick={() => refetchList()} className="ml-2 text-primary underline">
              Retry
            </button>
          </div>
        ) : personEvents.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground py-20">
            <ScanFace className="h-12 w-12 mb-4 opacity-50" />
            <p className="text-lg">No person/face events found</p>
            <p className="text-sm mt-1">Try widening the date range or switching to All Events.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {personEvents.map(({ event, boxes }) => {
              const recognized = boxes.filter((b) => b.identity).length;
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
                  <div className="relative aspect-video bg-black overflow-hidden">
                    {event.imageUrl ? (
                      <img
                        src={event.imageUrl}
                        alt={`Event on ${event.cameraName}`}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xs text-white/40">
                        No image
                      </div>
                    )}
                    {renderPersonBoxes(boxes)}
                    <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/85 text-xs font-medium flex items-center gap-1.5 text-white">
                      <User className="h-3 w-3" />
                      {boxes.map((b) => b.identity ?? b.letter).join(', ')}
                    </div>
                    {recognized > 0 && (
                      <div className="absolute top-2 right-2 px-2 py-0.5 rounded bg-emerald-500/90 text-black text-[10px] font-semibold flex items-center gap-1">
                        <ScanFace className="h-3 w-3" />
                        {recognized} recognized
                      </div>
                    )}
                    <div className="absolute bottom-2 right-2 px-2 py-1 rounded bg-black/85 text-xs font-mono tabular-nums">
                      <span
                        className={cn(
                          event.confidence >= 0.8
                            ? 'text-green-400'
                            : event.confidence >= 0.5
                              ? 'text-amber-400'
                              : 'text-muted-foreground',
                        )}
                      >
                        {(event.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                  <div className="p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-foreground/90 truncate">
                        {event.cameraName ?? event.cameraId}
                      </p>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <User className="h-3 w-3" />
                        {boxes.length} {boxes.length === 1 ? 'person' : 'persons'}
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