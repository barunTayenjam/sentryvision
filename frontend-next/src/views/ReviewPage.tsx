'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/hooks/use-toast';
import { reviewService } from '@/services/api/reviewService';
import { cn } from '@/lib/utils';
import { CheckCircle2, ImageOff, Loader2, Mail, X } from 'lucide-react';

type ReviewSegment = {
  id: string;
  camera: string;
  start_time: string;
  end_time: string;
  severity: 'alert' | 'detection';
  labels: string[];
  thumbnail_path: string | null;
  preview_path: string | null;
  data?: Record<string, unknown>;
};

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getSeverityLabel(severity: 'alert' | 'detection'): string {
  return severity === 'alert' ? 'Alert' : 'Detection';
}

export default function ReviewPage() {
  const [activeTab, setActiveTab] = useState<'alert' | 'detection'>('alert');
  const [segments, setSegments] = useState<ReviewSegment[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unreviewedCounts, setUnreviewedCounts] = useState({
    alert: 0,
    detection: 0,
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [allSelected, setAllSelected] = useState(false);
  const [actionModalOpen, setActionModalOpen] = useState(false);
  const [actionType, setActionType] = useState<'dismiss' | 'confirm' | null>(
    null,
  );
  const { toast } = useToast();

  const fetchCounts = useCallback(async () => {
    try {
      const counts = await reviewService.getCounts();
      setUnreviewedCounts(counts);
    } catch (err) {
      console.error('Failed to fetch review counts', err);
      toast({
        variant: 'destructive',
        title: 'Failed to load review counts',
      });
    }
  }, [toast]);

  const fetchSegments = useCallback(
    async (options: { append?: boolean } = {}) => {
      if (!loadingMore && options.append) {
        setLoadingMore(true);
      } else if (!options.append) {
        setLoading(true);
      }
      try {
        const res = await reviewService.getSegments({
          severity: activeTab,
          limit: limit,
          offset: offset,
        });
        if (options.append) {
          setSegments((prev) => [...prev, ...res.segments]);
          setOffset((prev) => prev + res.segments.length);
          setHasMore(res.hasMore);
        } else {
          setSegments(res.segments);
          setTotal(res.total);
          setOffset(res.segments.length);
          setHasMore(res.hasMore);
          setLimit(res.segments.length);
        }
      } catch (err) {
        console.error('Failed to fetch review segments', err);
        toast({
          variant: 'destructive',
          title: 'Failed to load review segments',
        });
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [activeTab, limit, offset, toast, loadingMore],
  );

  const handleTabChange = useCallback(
    (tab: 'alert' | 'detection') => {
      setActiveTab(tab);
      setOffset(0);
      setLimit(20);
      fetchSegments();
    },
    [fetchSegments],
  );

  const handleSelectSegment = useCallback(
    (id: string, event: React.MouseEvent) => {
      const isCtrl = event.metaKey || event.ctrlKey;
      if (isCtrl) {
        setSelectedIds((prev) =>
          prev.includes(id)
            ? prev.filter((sid) => sid !== id)
            : [...prev, id],
        );
      } else {
        if (event.shiftKey) {
          // TODO: implement shift-select range
          setSelectedIds([id]);
        } else {
          setSelectedIds([id]);
        }
      }
      setAllSelected(false);
    },
    [],
  );

  const handleSelectAll = useCallback(() => {
    setAllSelected((prev) => {
      const newSelected = !prev;
      setSelectedIds(
        newSelected
          ? segments.map((s) => s.id)
          : [],
      );
      return !prev;
    });
  }, [segments]);

  const handleAcknowledge = useCallback(
    async (action: 'dismiss' | 'confirm') => {
      if (selectedIds.length === 0) return;
      setActionModalOpen(false);
      try {
        await reviewService.batchAcknowledge(selectedIds, action);
        toast({
          title: `${selectedIds.length} items marked as ${
            action === 'dismiss' ? 'dismissed' : 'confirmed'
          }`,
        });
        setSelectedIds([]);
        setAllSelected(false);
        await fetchCounts();
        await fetchSegments();
      } catch (err) {
        console.error('Failed to acknowledge segments', err);
        toast({
          variant: 'destructive',
          title: 'Failed to acknowledge segments',
        });
      }
    },
    [
      selectedIds,
      toast,
      fetchCounts,
      fetchSegments,
    ],
  );

  const handleRefresh = useCallback(async () => {
    await fetchCounts();
    await fetchSegments();
  }, [fetchCounts, fetchSegments]);

  useEffect(() => {
    fetchCounts();
    fetchSegments();
    // TODO: set up real-time updates via Socket.io for new segments
    // For now, refresh every 30s
    const interval = setInterval(() => {
      fetchCounts();
      fetchSegments();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchCounts, fetchSegments]);

  useEffect(() => {
    if (offset > 0 && hasMore && !loadingMore) {
      fetchSegments({ append: true });
    }
  }, [offset, hasMore, loadingMore, fetchSegments]);

  if (loading && segments.length === 0) {
    return (
      <div className="min-h-[200px] flex flex-col items-center justify-center p-8">
        <Loader2 className="h-10 w-10 text-muted-foreground animate-spin" />
        <p className="mt-4 text-muted-foreground">Loading review segments...</p>
      </div>
    );
  }

  const isEmpty =
    segments.length === 0 && total === 0 && !loading && !loadingMore;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center space-x-4">
          <h1 className="text-xl font-semibold">
            Review
          </h1>
          <div className="flex items-center space-x-3 text-sm">
            <div
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded',
                activeTab === 'alert'
                  ? 'border-destructive/50 bg-destructive/10 text-destructive'
                  : 'border-warning/50 bg-warning/10 text-warning',
              )}
            >
              Alerts <span className="font-medium">{unreviewedCounts.alert}</span>
            </div>
            <div
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded',
                activeTab === 'detection'
                  ? 'border-warning/50 bg-warning/10 text-warning'
                  : 'border-input/50 bg-input/10 text-muted-foreground',
              )}
              onClick={() => handleTabChange('detection')}
            >
              Detections <span className="font-medium">{unreviewedCounts.detection}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={handleRefresh}
            className="btn btn-sm btn-ghost hover:btn-active"
            title="Refresh"
          >
            <Loader2 className="h-4 w-4" />
          </button>
          {selectedIds.length > 0 && (
            <>
              <button
                onClick={() => setActionType('dismiss')}
                className="btn btn-sm btn-ghost hover:btn-active text-destructive"
                title="Mark as dismissed"
              >
                <X className="h-4 w-4" />
              </button>
              <button
                onClick={() => setActionType('confirm')}
                className="btn btn-sm btn-ghost hover:btn-active text-green-400"
                title="Mark as confirmed"
              >
                <CheckCircle2 className="h-4 w-4" />
              </button>
              <button
                onClick={() => setActionModalOpen(true)}
                className="btn btn-sm btn-ghost hover:btn-active"
                title="Apply action"
              >
                <Mail className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {isEmpty ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No review segments found. Review segments are created when
            detection events occur.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-muted">
              <thead>
                <tr className="bg-muted">
                  <th
                    className="text-left text-xs font-medium text-muted-foreground p-3"
                    scope="col"
                  >
                    <div className="flex items-center space-x-2">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={handleSelectAll}
                        className="h-4 w-4"
                      />
                      <span className="sr-only">Select all</span>
                    </div>
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground p-3" scope="col">
                    Thumbnail
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground p-3" scope="col">
                    Camera
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground p-3" scope="col">
                    Time
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground p-3" scope="col">
                    Objects
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground p-3" scope="col">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-muted">
                {segments.map((segment) => {
                  const isSelected = selectedIds.includes(segment.id);
                  return (
                    <tr
                      key={segment.id}
                      className={cn(
                        'cursor-pointer hover:bg-muted/50',
                        isSelected ? 'bg-muted' : '',
                        'transition-colors'
                      )}
                      onClick={(e) => handleSelectSegment(segment.id, e)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        handleSelectSegment(segment.id, e);
                      }}
                    >
                      <td className="p-3">
                        <div className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => {
                              e.stopPropagation();
                              handleSelectSegment(
                                segment.id,
                                e as unknown as React.MouseEvent,
                              );
                            }}
                            className="h-4 w-4"
                          />
                          <span className="sr-only">Select segment</span>
                        </div>
                      </td>
                      <td className="p-3">
                        <img
                          src={`/api/review/segments/${encodeURIComponent(segment.id)}/thumbnail`}
                          alt={`${segment.camera} thumbnail`}
                          className="h-24 w-24 object-cover rounded bg-muted/50"
                          onError={(e) => {
                            (e.currentTarget as HTMLElement).style.display = 'none';
                            const fallback = e.currentTarget.nextElementSibling as HTMLElement | null;
                            if (fallback) fallback.style.display = 'flex';
                          }}
                        />
                        <div
                          style={{ display: 'none' }}
                          className="h-24 w-24 items-center justify-center rounded border border-muted bg-muted/50"
                        >
                          <ImageOff className="h-5 w-5 text-muted-foreground" />
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="space-y-1">
                          <div className="font-medium">{segment.camera}</div>
                          <div className="text-xs text-muted-foreground">
                            {getSeverityLabel(segment.severity)}
                          </div>
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="text-xs text-muted-foreground">
                          {formatDate(segment.start_time)}
                        </div>
                        {segment.start_time !== segment.end_time && (
                          <div className="text-xs text-muted-foreground">
                            – {formatDate(segment.end_time)}
                          </div>
                        )}
                      </td>
                      <td className="p-3">
                        <div className="flex flex-wrap gap-1">
                          {segment.labels.map((label, idx) => (
                            <span
                              key={idx}
                              className="px-2 py-0.5 text-xs rounded bg-muted/50"
                            >
                              {label}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="p-3 space-x-2">
                        <div className="flex items-center space-x-2">
                          {segment.data?.event_id ? (
                            <a
                              href={`/events/${segment.data.event_id}`}
                              className="text-sm text-muted-foreground hover:underline"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              View event
                            </a>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {loadingMore && (
                  <tr>
                    <td colSpan={6} className="p-4 text-center">
                      <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="flex justify-center py-4">
              <button
                onClick={() => {
                  setOffset((prev) => prev + limit);
                  fetchSegments({ append: true });
                }}
                className="btn btn-sm btn-primary"
              >
                Load more
              </button>
            </div>
          )}
        </div>
      )}

      {/* Action Modal */}
      <div
        className={cn(
          actionModalOpen ? 'fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/50' : 'hidden'
        )}
      >
        <div className="relative w-full max-w-md p-6 bg-popover rounded-lg shadow-lg">
          <div className="flex justify-between items-start pb-2">
            <h2 className="text-lg font-semibold">
              Mark selected items as
            </h2>
            <button
              onClick={() => setActionModalOpen(false)}
              className="btn btn-sm btn-ghost hover:btn-active"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-4">
            <p className="text-sm">
              {selectedIds.length} segment{selectedIds.length === 1 ? '' : 's'} selected
            </p>
            <div className="flex items-center space-x-3">
              <label className="cursor-pointer select-none flex items-center space-x-2">
                <input
                  type="radio"
                  name="reviewAction"
                  value="dismiss"
                  checked={actionType === 'dismiss'}
                  onChange={() => setActionType('dismiss')}
                  className="h-4 w-4"
                />
                Mark as dismissed
              </label>
              <label className="cursor-pointer select-none flex items-center space-x-2">
                <input
                  type="radio"
                  name="reviewAction"
                  value="confirm"
                  checked={actionType === 'confirm'}
                  onChange={() => setActionType('confirm')}
                  className="h-4 w-4"
                />
                Mark as confirmed
              </label>
            </div>
          </div>
          <div className="flex justify-end space-x-3">
            <button
              onClick={() => setActionModalOpen(false)}
              className="btn btn-sm btn-ghost hover:btn-active"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                if (actionType) handleAcknowledge(actionType);
              }}
              className="btn btn-sm btn-primary"
            >
              {actionType === 'dismiss' ? 'Dismiss' : 'Confirm'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}