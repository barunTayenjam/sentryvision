'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useUrlSearchParams } from '@/hooks/useUrlSearchParams';
import { useToast } from '@/hooks/use-toast';
import { useCameraStore } from '@/stores/camera';
import { useEventsList, useSemanticEvents } from '@/hooks/useEvents';
import { MotionEvent, EventRelation, RelationBox, RelationThreat } from '@/types/security';
import { SmartFilters, FilterState } from '@/components/events/SmartFilters';
import { EventDetailPanel } from '@/components/events/EventDetailPanel';
import { RelatedEvents } from '@/components/events/RelatedEvents';
import { EmptyState } from '@/components/ui/EmptyState';
import { eventService } from '@/services/api/eventService';
import { detectionService } from '@/services/api/detectionService';
import { Calendar, CheckCircle2, AlertTriangle, Search, X, Sparkles, ChevronDown } from 'lucide-react';
import { digestService, DailyDigest } from '@/services/api/digestService';
import { cn } from '@/lib/utils';
import { detectionInfo } from '@/lib/detectionMeta';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationPrevious,
  PaginationLink,
  PaginationNext,
} from '@/components/ui/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type SortOption = 'newest' | 'oldest' | 'confidence';

function getFilterFromParams(params: URLSearchParams): FilterState {
  return {
    cameraId: params.get('cameraId') || 'all',
    detectionType: (params.get('detectionType') || 'person') as FilterState['detectionType'],
    quickRange: (params.get('quickRange') || 'all') as FilterState['quickRange'],
    dateRange: {
      start: params.get('startDate') ? new Date(params.get('startDate')!) : undefined,
      end: params.get('endDate') ? new Date(params.get('endDate')!) : undefined,
    },
  };
}

const PERSON_CONFIDENCE_FLOOR = 0.55;

interface HumanVerificationMeta {
  tier: 'yolo_high' | 'face' | 'pose' | 'score_floor' | 'disabled';
  keypoints: number;
  faceDetected: boolean;
  elapsedMs: number;
}

const TIER_LABELS: Record<HumanVerificationMeta['tier'], string> = {
  yolo_high: 'YOLO ≥ 0.90',
  face: 'Face detected',
  pose: 'Pose skeleton',
  score_floor: 'Score floor',
  disabled: 'Verifier off',
};

const TIER_COLORS: Record<HumanVerificationMeta['tier'], string> = {
  yolo_high: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  face: 'text-green-400 bg-green-500/10 border-green-500/20',
  pose: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  score_floor: 'text-muted-foreground bg-white/[0.06] border-white/[0.10]',
  disabled: 'text-muted-foreground bg-white/[0.06] border-white/[0.10]',
};

function getVerification(event: MotionEvent): HumanVerificationMeta | null {
  const hv = event.metadata?.humanVerification as HumanVerificationMeta | undefined;
  return hv && typeof hv.tier === 'string' ? hv : null;
}

type EventsPageProps = { embedded?: boolean };

const EventsPage = ({ embedded = false }: EventsPageProps) => {
  const { toast } = useToast();
  const cameras = useCameraStore((state) => state.cameras);
  const searchParams = useUrlSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/';

  const [analyzingEventId, setAnalyzingEventId] = useState<string | null>(null);
  const [analysisByEvent, setAnalysisByEvent] = useState<Record<string, AnalysisEntry>>({});
  const [relationsByEvent, setRelationsByEvent] = useState<
    Record<string, { relations: EventRelation[]; boxes?: RelationBox[] } | null>
  >({});
  const [threatByEvent, setThreatByEvent] = useState<Record<string, RelationThreat | null>>({});

  const currentPage = Math.max(1, parseInt(searchParams.get('page') || '1') || 1);
  const sortBy = (searchParams.get('sortBy') || 'newest') as SortOption;
  const selectedEventId = searchParams.get('eventId');
  const searchQuery = (searchParams.get('q') || '').trim();
  const digestParam = searchParams.get('digest');
  const [digest, setDigest] = useState<DailyDigest | null>(null);
  const [digestCollapsed, setDigestCollapsed] = useState(false);
  const [digestLoading, setDigestLoading] = useState(!!digestParam);
  const [searchInput, setSearchInput] = useState(searchQuery);
  const filters = useMemo(() => getFilterFromParams(searchParams), [searchParams]);

  useEffect(() => {
    if (!digestParam) return;
    let cancelled = false;
    digestService
      .get(digestParam)
      .then((d) => {
        if (cancelled) return;
        setDigest(d);
      })
      .catch(() => {
        if (!cancelled) setDigest(null);
      })
      .finally(() => {
        if (!cancelled) setDigestLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [digestParam]);

  const { data: listData, isLoading: listLoading, isError: listError, refetch: refetchList } =
    useEventsList({
      page: currentPage,
      pageSize: 12,
      camera_id: filters.cameraId === 'all' ? undefined : filters.cameraId,
      event_type: filters.detectionType === 'all' ? undefined : filters.detectionType,
      min_confidence: filters.detectionType === 'person' ? PERSON_CONFIDENCE_FLOOR : undefined,
      start_date: filters.dateRange.start?.toISOString(),
      end_date: filters.dateRange.end?.toISOString(),
      sortBy,
    });
  const { data: semanticData, isLoading: semanticLoading } = useSemanticEvents(searchQuery || '', {
    cameraId: filters.cameraId === 'all' ? undefined : filters.cameraId,
    limit: 24,
  });

  const isSearchMode = searchQuery.length > 0;
  const isLoading = isSearchMode ? semanticLoading : listLoading;
  const isError = !isSearchMode && listError;
  const refetch = refetchList;
  const events = isSearchMode ? semanticData?.events ?? [] : listData?.events ?? [];
  const totalPages = listData?.totalPages ?? 1;

  useEffect(() => {
    if (isError) toast({ title: 'Error', description: 'Failed to load events', variant: 'destructive' });
  }, [isError, toast]);

  // Load existing analysis if not in state
  useEffect(() => {
    if (!selectedEventId || analysisByEvent[selectedEventId]) return;

    let cancelled = false;
    detectionService
      .getEventAnalysis(selectedEventId)
      .then((res) => {
        if (cancelled) return;
        if (res.analysis) {
          const a = res.analysis;
          setAnalysisByEvent((prev) => ({
            ...prev,
            [selectedEventId]: {
              sceneDescription: a.sceneDescription || '',
              summary: a.summary || a.sceneDescription || '',
              threatAssessment: a.threatAssessment,
              detectedEntities: a.detectedEntities,
              recommendedActions: a.recommendedActions,
              modelUsed: a.model,
              processingTime: a.processing_time_ms || 0,
              boxes: res.boxes?.length ? res.boxes : undefined,
            },
          }));
        }
      })
      .catch(() => {
        // stored analysis unavailable — panel simply stays empty until analyzed
      });

    return () => { cancelled = true; };
  }, [selectedEventId, analysisByEvent]);

  // Lazily compute/serve scene relations for the selected event
  useEffect(() => {
    if (!selectedEventId || relationsByEvent[selectedEventId] !== undefined) return;

    let cancelled = false;
    eventService
      .getEventRelations(selectedEventId)
      .then((res) => {
        if (cancelled) return;
        setRelationsByEvent((prev) => ({
          ...prev,
          [selectedEventId]: { relations: res.relations, boxes: res.boxes },
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setRelationsByEvent((prev) => ({ ...prev, [selectedEventId]: null }));
      });

    return () => { cancelled = true; };
  }, [selectedEventId, relationsByEvent]);

  // AI threat assessment grounded in the stored relations (computed on first open)
  useEffect(() => {
    if (!selectedEventId || threatByEvent[selectedEventId] !== undefined) return;
    if (!relationsByEvent[selectedEventId]?.relations?.length) return;

    let cancelled = false;
    eventService
      .getEventRelationThreat(selectedEventId)
      .then((res) => {
        if (cancelled) return;
        setThreatByEvent((prev) => ({ ...prev, [selectedEventId]: res.threat }));
      })
      .catch(() => {
        if (cancelled) return;
        setThreatByEvent((prev) => ({ ...prev, [selectedEventId]: null }));
      });

    return () => { cancelled = true; };
  }, [selectedEventId, relationsByEvent, threatByEvent]);


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

  const handleSortChange = useCallback(
    (value: SortOption) => {
      updateParams({ sortBy: value !== 'newest' ? value : null, page: null });
    },
    [updateParams],
  );

  const handleDigestClear = useCallback(() => {
    setDigest(null);
    updateParams({ digest: null });
  }, [updateParams]);

  const handlePageChange = useCallback(
    (page: number) => {
      updateParams({ page: page > 1 ? String(page) : null, eventId: null });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [updateParams],
  );

  const handleSearchSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      updateParams({ q: trimmed || null, page: null, eventId: null });
    },
    [updateParams],
  );

  const handleSearchClear = useCallback(() => {
    setSearchInput('');
    handleSearchSubmit('');
  }, [handleSearchSubmit]);

  const selectedEvent = events.find((e) => e.id === selectedEventId) || null;

  const handleAnalyzeEvent = useCallback(
    async (eventId: string) => {
      setAnalyzingEventId(eventId);
      try {
        const result = await detectionService.analyzeEvent(eventId);

        if (result.success && result.analysis) {
          const a = result.analysis;
          setAnalysisByEvent((prev) => ({
            ...prev,
            [eventId]: {
              sceneDescription: a.sceneDescription || a.overall_summary || a.summary || '',
              summary: a.summary,
              threatAssessment:
                a.threatAssessment || { level: 'low', factors: [], confidence: 0 },
              detectedEntities: a.detectedEntities || {
                people: (a.persons as string[]) || [],
                vehicles: (a.vehicles as string[]) || [],
                animals: [],
                objects: [],
              },
              recommendedActions: a.recommendedActions || [],
              processingTime: a.processing_time_ms || a.processingTime || 0,
              modelUsed: a.model || a.modelUsed || 'unknown',
              boxes: (a.boundingBoxes as never) || undefined,
            },
          }));
          toast({
            title: 'AI Analysis Complete',
            description: a.overall_summary || a.sceneDescription || a.summary || 'Event analyzed',
          });
        } else {
          toast({
            title: 'Analysis Failed',
            description: result.message || 'Unknown error',
            variant: 'destructive',
          });
        }
      } catch (error) {
        toast({
          title: 'Analysis Failed',
          description: error instanceof Error ? error.message : 'Unknown error',
          variant: 'destructive',
        });
      } finally {
        setAnalyzingEventId(null);
      }
    },
    [toast],
  );

  const handleEventSelect = useCallback(
    (eventId: string) => {
      updateParams({ eventId: eventId === selectedEventId ? null : eventId });
    },
    [updateParams, selectedEventId],
  );

  const goToSibling = useCallback(
    (direction: 1 | -1) => {
      if (!selectedEvent) return;
      const idx = events.findIndex((e) => e.id === selectedEvent.id);
      const next = events[idx + direction];
      if (next) updateParams({ eventId: next.id });
    },
    [selectedEvent, events, updateParams],
  );

  const handleEventDelete = useCallback(
    async (eventId: string) => {
      try {
        await eventService.archiveEvent(eventId);
        toast({ title: 'Event Deleted', description: 'The event has been deleted.' });
        updateParams({ eventId: null });
        void refetch();
      } catch {
        toast({ title: 'Error', description: 'Failed to delete event', variant: 'destructive' });
      }
    },
    [toast, updateParams, refetch],
  );

  const handleEventDownload = useCallback((event: MotionEvent) => {
    if (!event.imageUrl) return;
    const link = document.createElement('a');
    link.href = event.imageUrl;
    link.download = `event_${event.cameraId}.jpg`;
    link.click();
  }, []);

  const cameraList = cameras.map((c) => ({ id: c.id, name: c.name }));

  return (
    <div className="w-full h-full flex flex-col bg-background">
      {!embedded && (
        <header className="shrink-0 border-b border-white/[0.06] bg-card py-4">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-[-0.03em] text-foreground">Events</h1>
              {isSearchMode && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary border border-primary/20">
                  <Search className="h-3 w-3" />
                  Semantic
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <div className="hidden sm:flex items-center gap-2">
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSearchSubmit(searchInput);
                  }}
                  placeholder="Search scenes… e.g. person at night"
                  className="h-8 w-56 rounded-md bg-white/[0.04] border border-white/[0.10] px-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                />
                <button
                  onClick={() => handleSearchSubmit(searchInput)}
                  className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Search
                </button>
              </div>
              <Select value={sortBy} onValueChange={(value: SortOption) => handleSortChange(value)}>
              <SelectTrigger className="w-[130px] h-8 rounded-md bg-white/[0.04] border-white/[0.10] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-card border-white/[0.10] rounded-lg">
                <SelectItem value="newest" className="rounded-md text-xs">
                  Newest
                </SelectItem>
                <SelectItem value="oldest" className="rounded-md text-xs">
                  Oldest
                </SelectItem>
                <SelectItem value="confidence" className="rounded-md text-xs">
                  Confidence
                </SelectItem>
              </SelectContent>
            </Select>
            </div>
          </div>
        </header>
      )}

       {/* Content */}
      <div className="flex-1 flex flex-col xl:flex-row overflow-hidden">
        <div className="flex-1 overflow-y-auto mx-auto px-4 pt-5 pb-8 sm:px-6 sm:pt-6 sm:pb-10 max-w-7xl w-full">
          {/* Filters */}
          <div className="mb-4 border-b border-white/[0.06] pb-3">
            <SmartFilters cameras={cameraList} filters={filters} onFiltersChange={handleFiltersChange} />
          </div>

          {digestLoading && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-card px-3 py-2 text-xs text-muted-foreground">
              <Sparkles className="h-4 w-4 animate-pulse" />
              Loading daily digest…
            </div>
          )}

          {digest && !digestCollapsed && (
            <div className="mb-4 rounded-lg border border-primary/20 bg-primary/[0.06] px-3 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <span className="font-medium text-foreground">{digest.title}</span>
                <span className="text-muted-foreground">
                  {digest.event_count.toLocaleString('en-IN')} events ·{' '}
                  {digest.detection_count.toLocaleString('en-IN')} detections
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={() => setDigestCollapsed(true)}
                    className="rounded-md px-2 py-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                    title="Collapse"
                  >
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  <button
                    onClick={handleDigestClear}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
                    title="Close"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <div className="mt-2 space-y-1 text-foreground/80">
                {digest.body.split('\n').map((line, i) => (
                  <p key={i} className={line.startsWith('**') ? 'font-medium text-foreground' : ''}>
                    {line.replace(/\*\*/g, '')}
                  </p>
                ))}
              </div>
            </div>
          )}

          {isSearchMode && (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/[0.06] px-3 py-2 text-xs">
              <Search className="h-4 w-4 text-primary" />
              <span className="text-foreground">
                Semantic search for <span className="font-medium">&ldquo;{searchQuery}&rdquo;</span>
                {' — '}
                <span className="text-muted-foreground">
                  {semanticData?.semanticHits ?? 0} semantic + {semanticData?.keywordHits ?? 0} keyword hits
                </span>
              </span>
              <button
                onClick={handleSearchClear}
                className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              >
                <X className="h-3 w-3" /> Clear
              </button>
            </div>
          )}

          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {[...Array(8)].map((_, i) => (
                <div
                  key={i}
                  className="animate-pulse rounded-lg overflow-hidden bg-card border border-white/[0.10]"
                >
                  <div className="aspect-video bg-white/[0.04]" />
                  <div className="p-4 space-y-2">
                    <div className="h-3 bg-white/[0.06] rounded w-3/4" />
                    <div className="h-2 bg-white/[0.04] rounded w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : isError ? (
            <EmptyState
              icon={AlertTriangle}
              title="Couldn't load events"
              description="The server didn't respond. This is not the same as no events — a security system must never show an empty screen when data is unavailable."
              className="py-20"
              action={{ label: 'Retry', onClick: () => refetch() }}
            />
          ) : events.length === 0 ? (
            <EmptyState
              icon={Calendar}
              title="No events found"
              description="No confirmed person events match these filters. Try widening the date range or switching to All Events."
              className="py-20"
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {events.map((event) => {
                const verification = getVerification(event);
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
                    {/* Image */}
                    <div className="relative aspect-video bg-black">
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

                      {/* Verification badge */}
                      {verification && (
                        <div className={cn(
                          'absolute top-2 left-2 inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border',
                          TIER_COLORS[verification.tier],
                        )}>
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          {TIER_LABELS[verification.tier]}
                        </div>
                      )}

                      {/* Person count */}
                      {(event.personCount ?? 0) > 0 && (
                        <div className="absolute bottom-2 left-2 px-2 py-1 rounded bg-black/85 text-white text-xs font-medium">
                          {event.personCount} {event.personCount === 1 ? 'person' : 'persons'}
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
                        {verification && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            {verification.tier === 'yolo_high' && <AlertTriangle className="w-3 h-3 text-blue-400" />}
                            {verification.tier === 'face' && <CheckCircle2 className="w-3 h-3 text-green-400" />}
                            {verification.tier === 'pose' && <AlertTriangle className="w-3 h-3 text-amber-400" />}
                          </div>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1 font-mono tabular-nums">
                        {event.timestamp.toLocaleString()}
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
                      onClick={
                        currentPage === totalPages ? undefined : () => handlePageChange(currentPage + 1)
                      }
                      className={currentPage === totalPages ? 'pointer-events-none opacity-40' : ''}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}
        </div>

        {/* Event Detail Panel */}
        {selectedEvent && (
          <>
            <EventDetailPanel
              event={selectedEvent}
              events={events}
              onClose={() => updateParams({ eventId: null })}
              onNext={() => goToSibling(1)}
              onPrevious={() => goToSibling(-1)}
              onDelete={handleEventDelete}
              onDownload={handleEventDownload}
              onAnalyze={handleAnalyzeEvent}
              analyzing={analyzingEventId === selectedEvent.id}
              analysis={analysisByEvent[selectedEvent.id] ?? null}
              boxes={analysisByEvent[selectedEvent.id]?.boxes}
              relations={selectedEvent.id in relationsByEvent ? relationsByEvent[selectedEvent.id]?.relations : undefined}
              relationBoxes={selectedEvent.id in relationsByEvent ? relationsByEvent[selectedEvent.id]?.boxes : undefined}
              relationThreat={selectedEvent.id in threatByEvent ? threatByEvent[selectedEvent.id] : undefined}
            />
            <div className="w-full xl:w-[320px] xl:border-l border-t xl:border-t-0 border-white/[0.10] overflow-y-auto bg-background">
              {/* Verification Panel */}
              {(() => {
                const v = getVerification(selectedEvent);
                if (!v) return null;
                const info = detectionInfo(selectedEvent);
                const rows: Array<[string, string]> = [
                  ['Method', TIER_LABELS[v.tier]],
                  ...info.verification.map((row) => [row.label, row.value] as [string, string]),
                ];
                const verdict =
                  info.verified === true
                    ? {
                        label: 'Verified',
                        className: 'text-green-400 bg-green-500/10 border-green-500/20',
                        Icon: CheckCircle2,
                      }
                    : info.verified === false
                      ? {
                          label: 'Rejected',
                          className: 'text-red-400 bg-red-500/10 border-red-500/20',
                          Icon: AlertTriangle,
                        }
                      : {
                          label: 'Unknown',
                          className: 'text-muted-foreground bg-white/[0.06] border-white/[0.10]',
                          Icon: AlertTriangle,
                        };
                return (
                  <div className="m-4 p-4 rounded-lg bg-card border border-white/[0.10]">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-medium text-muted-foreground">
                        Human Verification
                      </span>
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border',
                          verdict.className,
                        )}
                      >
                        <verdict.Icon className="w-2.5 h-2.5" />
                        {verdict.label}
                      </span>
                    </div>
                    {rows.map(([label, value]) => (
                      <div key={label} className="flex items-center justify-between text-xs py-1.5 border-b border-white/[0.06] last:border-0">
                        <span className="text-muted-foreground">{label}</span>
                        <span className="text-foreground/90 font-medium font-mono tabular-nums">{value}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
              <RelatedEvents
                currentEvent={selectedEvent}
                events={events}
                onEventSelect={handleEventSelect}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

type AnalysisEntry = {
  sceneDescription?: string;
  summary?: string;
  threatAssessment?: { level: string; factors: string[]; confidence: number };
  detectedEntities?: { people: string[]; vehicles: string[]; animals: string[]; objects: string[] };
  recommendedActions?: string[];
  processingTime?: number;
  modelUsed?: string;
  boxes?: Array<{ label: string; confidence: number; x: number; y: number; width: number; height: number }>;
};

export default EventsPage;
