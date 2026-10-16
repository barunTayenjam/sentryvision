'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useCameraStore } from '@/stores/camera';
import {
  Film,
  ChevronLeft,
  ChevronRight,
  Wand2,
  Check,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageLoading } from '@/components/ui/PageLoading';
import { PageContainer } from '@/components/layout/PageContainer';
import { useToast } from '@/hooks/use-toast';
import { systemService } from '@/services/api/systemService';
import { cn } from '@/lib/utils';

type CamStatus = 'idle' | 'queued' | 'generating' | 'done' | 'error';

interface CamMeta {
  frames: number;
  skipped: number;
  source: 'raw' | 'detection' | 'unknown';
}

interface CamState {
  status: CamStatus;
  message?: string;
  exists: boolean;
  meta?: CamMeta;
}

const formatLocalDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const todayStr = () => formatLocalDate(new Date());

const TimelapsePage: React.FC = () => {
  const cameras = useCameraStore((state) => state.cameras);
  const [date, setDate] = useState(todayStr());
  const [list, setList] = useState<{ cameraId: string; path: string }[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [camStates, setCamStates] = useState<Record<string, CamState>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const { toast } = useToast();

  const isPast = date < todayStr();
  const isPastRef = useRef(isPast);
  isPastRef.current = isPast;

  // Identity-stable camera key: motion events replace the cameras array every
  // few seconds (lastSeen bumps) — re-running the fetch effect on each one
  // wiped in-progress timelapse state. Refetch only when the camera SET changes.
  const camerasRef = useRef(cameras);
  camerasRef.current = cameras;
  const cameraIdsKey = cameras.map((c) => c.id).join(',');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setActive(null);
    setList([]);
    setCamStates({});
    setSelected(new Set());
    const past = isPastRef.current;
    const currentCameras = camerasRef.current;
    systemService
      .getTimelapses(date)
      .then((res) => {
        if (cancelled) return;
        if (res.success) {
          const timelapses = res.timelapses ?? [];
          setList(timelapses);
          if (timelapses.length > 0) setActive(timelapses[0].cameraId);
          const existingIds = new Set(timelapses.map((t) => t.cameraId));
          const next: Record<string, CamState> = {};
          const nextSelected = new Set<string>();
          for (const cam of currentCameras) {
            const exists = existingIds.has(cam.id);
            next[cam.id] = { status: 'idle', exists };
            if (!exists && past) nextSelected.add(cam.id);
          }
          setCamStates(next);
          setSelected(nextSelected);
          if (past && timelapses.length < currentCameras.length) setPanelOpen(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to load timelapses:', err);
        // API failure must not look like "no footage that day".
        setLoadError(err instanceof Error ? err.message : 'Failed to load timelapses');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [date, cameraIdsKey, reloadKey]);

  const getCameraName = (cameraId: string) =>
    cameras.find((c) => c.id === cameraId)?.name || `Camera ${cameraId}`;

  const changeDate = useCallback(
    (days: number) => {
      const d = new Date(date + 'T00:00:00');
      d.setDate(d.getDate() + days);
      const next = formatLocalDate(d);
      if (next > todayStr()) return;
      setDate(next);
    },
    [date],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const el = e.target as HTMLElement;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return;
      changeDate(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [changeDate]);

  const toggleSelected = (camId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(camId)) next.delete(camId);
      else next.add(camId);
      return next;
    });
  };

  const generatingCount = useMemo(
    () =>
      Object.values(camStates).filter((s) => s.status === 'generating' || s.status === 'queued')
        .length,
    [camStates],
  );
  const busy = generatingCount > 0;
  const activeMeta = active ? camStates[active]?.meta : undefined;
  const activeTimelapse = active ? list.find((t) => t.cameraId === active) : undefined;

  const runGenerate = async (camId: string) => {
    setCamStates((p) => ({
      ...p,
      [camId]: { ...p[camId], status: 'generating', message: undefined },
    }));
    try {
      const res = await systemService.generateTimelapse(camId, date);
      const meta: CamMeta = { frames: res.frames, skipped: res.skipped, source: res.source as CamMeta['source'] };
      setCamStates((p) => ({
        ...p,
        [camId]: { status: 'done', exists: true, message: res.message, meta },
      }));
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setCamStates((p) => ({ ...p, [camId]: { ...p[camId], status: 'error', message: msg } }));
      throw err;
    }
  };

  const handleGenerateSelected = async () => {
    const targets = Array.from(selected);
    if (targets.length === 0) return;
    for (const camId of targets) {
      setCamStates((p) => ({ ...p, [camId]: { ...p[camId], status: 'queued' } }));
    }
    let ok = 0;
    let failed = 0;
    for (const camId of targets) {
      try {
        await runGenerate(camId);
        ok++;
      } catch {
        failed++;
      }
    }
    const fresh = await systemService.getTimelapses(date);
    if (fresh.success) {
      setList(fresh.timelapses);
      if (!active && fresh.timelapses.length > 0) setActive(fresh.timelapses[0].cameraId);
    }
    if (failed === 0) {
      toast({
        title: `Backfilled ${ok} camera${ok === 1 ? '' : 's'}`,
        description: `Timelapse ready for ${date}`,
      });
    } else {
      toast({
        title: `Backfill finished with ${failed} failure${failed === 1 ? '' : 's'}`,
        description: `${ok} succeeded`,
        variant: 'destructive',
      });
    }
    setSelected(new Set());
  };

  const handleGenerateSingle = async (camId: string) => {
    try {
      await runGenerate(camId);
      const fresh = await systemService.getTimelapses(date);
      if (fresh.success) {
        setList(fresh.timelapses);
        setActive(camId);
      }
      toast({ title: 'Timelapse ready', description: getCameraName(camId) });
    } catch (err) {
      toast({
        title: 'Generation failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    }
  };

  if (loading) {
    return (
      <div className="h-full overflow-y-auto bg-background">
        <PageLoading message="Loading Timelapses..." />
      </div>
    );
  }

  if (loadError) {
    return (
      <PageContainer className="space-y-4">
        <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <div className="w-14 h-14 rounded-full bg-white/[0.04] flex items-center justify-center border border-white/[0.10]">
            <AlertCircle className="h-6 w-6 text-muted-foreground" />
          </div>
          <div className="space-y-1.5">
            <h3 className="text-base font-medium">Couldn&apos;t load timelapses</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              The server didn&apos;t respond — this is not the same as &ldquo;no footage&rdquo; for
              this date.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </Button>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.06] pb-4">
          <span className="text-sm text-muted-foreground">{date}</span>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={date}
              max={todayStr()}
              onChange={(e) => e.target.value <= todayStr() && setDate(e.target.value)}
              className="bg-card border border-white/[0.10] rounded-lg px-3 py-1.5 text-sm text-foreground"
            />
            <Button onClick={() => changeDate(-1)} variant="outline" size="sm">
              <ChevronLeft className="w-4 h-4 mr-1" />
              Prev
            </Button>
            <Button
              onClick={() => changeDate(1)}
              variant="outline"
              size="sm"
              disabled={date >= todayStr()}
            >
              Next
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>

        {isPast && (
          <div className="rounded-lg border border-white/[0.10] bg-card">
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              className="w-full flex items-center justify-between p-4 text-left hover:bg-white/[0.03]"
            >
              <div className="flex items-center gap-3">
                <Wand2 className="w-4 h-4 text-primary" />
                <div>
                  <div className="text-sm font-medium">Backfill for {date}</div>
                  <div className="text-xs text-muted-foreground">
                    Stitches captured frames (or detection snapshots as fallback) into a 2-minute
                    MP4 per camera.
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {generatingCount > 0 && (
                  <Badge variant="secondary" className="gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {generatingCount} running
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {panelOpen ? 'Hide' : 'Show'}
                </span>
              </div>
            </button>

            {panelOpen && (
              <div className="border-t border-white/[0.10] p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {cameras.map((cam) => {
                    const st = camStates[cam.id] ?? {
                      status: 'idle' as CamStatus,
                      exists: false,
                    };
                    const checked = selected.has(cam.id);
                    const disabled = st.status === 'generating' || st.status === 'queued';
                    return (
                      <label
                        key={cam.id}
                        className={cn(
                          'flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                          checked
                            ? 'border-primary/60 bg-primary/5'
                            : 'border-white/[0.10] hover:bg-white/[0.03]',
                          disabled && 'opacity-60 cursor-not-allowed',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleSelected(cam.id)}
                          className="mt-0.5 accent-primary"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-medium truncate">
                              {getCameraName(cam.id)}
                            </span>
                            <StatusBadge state={st} />
                          </div>
                          {st.message && (
                            <div
                              className={cn(
                                'text-xs mt-1 break-words',
                                st.status === 'error'
                                  ? 'text-destructive'
                                  : 'text-muted-foreground',
                              )}
                            >
                              {st.message}
                              {st.meta && st.status === 'done' && (
                                <span className="block text-[11px] text-muted-foreground">
                                  {st.meta.frames} frames · {st.meta.source}
                                  {st.meta.skipped > 0 ? ` · ${st.meta.skipped} skipped` : ''}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const next = new Set<string>();
                        for (const cam of cameras) {
                          if (!camStates[cam.id]?.exists) next.add(cam.id);
                        }
                        setSelected(next);
                      }}
                    >
                      Select missing
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelected(new Set(cameras.map((c) => c.id)))}
                    >
                      Select all
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                      Clear
                    </Button>
                    <span>{selected.size} selected</span>
                  </div>
                  <Button
                    onClick={handleGenerateSelected}
                    disabled={selected.size === 0 || busy}
                    size="sm"
                  >
                    {busy ? (
                      <>
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                        Generating…
                      </>
                    ) : (
                      <>
                        <Wand2 className="w-3 h-3 mr-1" />
                        Generate {selected.size > 0 ? `(${selected.size})` : ''}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {list.length === 0 ? (
          <div className="rounded-lg border border-white/[0.10] bg-card">
            <div className="p-10 text-center">
              <Film className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <h3 className="text-base font-medium mb-1">
                {isPast ? 'No timelapse for this date yet' : 'Live capture in progress'}
              </h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                {isPast
                  ? 'Use the Backfill panel above to generate from captured frames or detection snapshots.'
                  : "Today's frames are being sampled every 30s. The timelapse will be stitched automatically at 00:01."}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 items-center">
              {list.map((t) => {
                const st = camStates[t.cameraId];
                return (
                  <Button
                    key={t.cameraId}
                    onClick={() => setActive(t.cameraId)}
                    variant={t.cameraId === active ? 'default' : 'outline'}
                    size="sm"
                  >
                    <Film className="w-3 h-3 mr-1" />
                    {getCameraName(t.cameraId)}
                    {st?.status === 'done' && (
                      <CheckCircle2 className="w-3 h-3 ml-1 text-emerald-400" />
                    )}
                  </Button>
                );
              })}
            </div>
            <div className="rounded-lg border border-white/[0.10] bg-card">
              <div className="overflow-hidden">
                <div className="relative aspect-video bg-black">
                  {(() => {
                    const src = list.find((t) => t.cameraId === active)?.path;
                    if (!src) {
                      return (
                        <div className="flex items-center justify-center h-full text-muted-foreground">
                          Select a camera
                        </div>
                      );
                    }
                    return (
                      <video
                        key={src}
                        src={src}
                        controls
                        autoPlay
                        muted
                        playsInline
                        loop
                        className="w-full h-full object-contain"
                      />
                    );
                  })()}
                </div>
                <div className="p-4 flex items-center justify-between flex-wrap gap-2">
                  <p className="text-sm text-muted-foreground">
                    {active && list.find((t) => t.cameraId === active) ? (
                      <>
                        2-minute timelapse for{' '}
                        <span className="text-foreground font-medium">{getCameraName(active)}</span>{' '}
                        on {date}.
                        {activeMeta && (
                          <span className="ml-1">
                            {activeMeta.frames} frames · source: {activeMeta.source}
                            {activeMeta.skipped > 0 ? ` · ${activeMeta.skipped} skipped` : ''}
                          </span>
                        )}
                      </>
                    ) : (
                      '2-minute timelapse of the full day at 24 fps.'
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    {active && isPast && (
                      <Button
                        onClick={() => handleGenerateSingle(active)}
                        disabled={busy}
                        variant="ghost"
                        size="sm"
                      >
                        <Wand2 className="w-3 h-3 mr-1" />
                        Regenerate
                      </Button>
                    )}
                    {active && (
                      <Button
                        asChild={!!activeTimelapse?.path}
                        disabled={!activeTimelapse?.path}
                        variant="ghost"
                        size="sm"
                      >
                        <a
                          href={activeTimelapse?.path}
                          download={`${active}-${date}.mp4`}
                        >
                          <Download className="w-3 h-3 mr-1" />
                          Download
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
    </PageContainer>
  );
};

const StatusBadge: React.FC<{ state: CamState }> = ({ state }) => {
  if (state.status === 'generating') {
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="w-3 h-3 animate-spin" />
        Generating
      </Badge>
    );
  }
  if (state.status === 'queued') {
    return <Badge variant="secondary">Queued</Badge>;
  }
  if (state.status === 'done') {
    return (
      <Badge className="gap-1 bg-emerald-500/15 text-emerald-300 border-emerald-500/30">
        <Check className="w-3 h-3" />
        Ready
      </Badge>
    );
  }
  if (state.status === 'error') {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertCircle className="w-3 h-3" />
        Failed
      </Badge>
    );
  }
  if (state.exists) {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/30 text-emerald-300">
        <CheckCircle2 className="w-3 h-3" />
        Exists
      </Badge>
    );
  }
  return <Badge variant="outline">Missing</Badge>;
};

export default TimelapsePage;
