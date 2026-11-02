'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Calendar, Camera, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  isToday,
  subMonths,
  addMonths,
  startOfWeek,
  endOfWeek,
} from 'date-fns';
import { eventService } from '@/services/api/eventService';

export interface FilterState {
  cameraId: string;
  detectionType: 'all' | 'motion' | 'person' | 'face' | 'vehicle';
  dateRange: { start: Date | undefined; end: Date | undefined };
  quickRange: 'all' | 'today' | 'yesterday' | 'last7days' | 'last30days';
  jevUrgent?: 'all' | 'true' | 'false';
}

interface SmartFiltersProps {
  cameras: { id: string; name: string }[];
  filters: FilterState;
  onFiltersChange?: (filters: FilterState) => void;
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

export const SmartFilters: React.FC<SmartFiltersProps> = ({
  cameras,
  filters,
  onFiltersChange,
}) => {
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [calendarData, setCalendarData] = useState<
    Record<
      string,
      { count: number; motion: number; face: number; persons: number; avgConfidence: number }
    >
  >({});
  const [showCalendar, setShowCalendar] = useState(false);

  const activeFilterCount = [
    filters.cameraId !== 'all',
    filters.detectionType !== 'all',
    filters.quickRange !== 'all',
    filters.dateRange.start !== undefined,
    filters.jevUrgent !== undefined && filters.jevUrgent !== 'all',
  ].filter(Boolean).length;

  const updateFilter = useCallback(
    <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
      const newFilters = { ...filters, [key]: value };
      if (key === 'quickRange' && value !== 'all') {
        const option = quickRangeOptions.find((o) => o.value === value);
        if (option) {
          const dates = option.getDates();
          newFilters.dateRange = { start: dates.start, end: dates.end };
        }
      } else if (key === 'quickRange' && value === 'all') {
        newFilters.dateRange = { start: undefined, end: undefined };
      }
      onFiltersChange?.(newFilters);
    },
    [filters, onFiltersChange],
  );

  const clearAllFilters = useCallback(() => {
    const cleared: FilterState = {
      cameraId: 'all',
      detectionType: 'all',
      dateRange: { start: undefined, end: undefined },
      quickRange: 'all',
      jevUrgent: 'all',
    };
    onFiltersChange?.(cleared);
  }, [onFiltersChange]);

  const fetchCalendarData = useCallback(async () => {
    try {
      const result = await eventService.getCalendarStats(
        calendarMonth.getFullYear(),
        calendarMonth.getMonth() + 1,
        filters.cameraId === 'all' ? undefined : filters.cameraId,
      );
      setCalendarData(result.data);
    } catch (error) {
      console.error('Error fetching calendar data:', error);
    }
  }, [calendarMonth, filters.cameraId]);

  useEffect(() => {
    if (showCalendar) fetchCalendarData();
  }, [showCalendar, fetchCalendarData]);

  const getDayClasses = (day: Date) => {
    const dateKey = format(day, 'yyyy-MM-dd');
    const dayData = calendarData[dateKey];
    const isCurrentMonth = isSameMonth(day, calendarMonth);
    const isSelected = filters.dateRange.start && isSameDay(day, filters.dateRange.start);
    if (!isCurrentMonth) return 'opacity-30';
    if (dayData && dayData.count > 0) {
      if (isSelected) return 'bg-primary';
      if (isToday(day)) return 'bg-amber-500 text-white';
      return 'bg-primary/20';
    }
    if (isSelected) return 'bg-primary';
    if (isToday(day)) return 'bg-amber-500 text-white';
    return 'hover:bg-white/[0.06]';
  };

  const calendarDays = eachDayOfInterval({
    start: startOfWeek(startOfMonth(calendarMonth)),
    end: endOfWeek(endOfMonth(calendarMonth)),
  });

  const handleCalendarDayClick = (day: Date) => {
    if (!isSameMonth(day, calendarMonth)) setCalendarMonth(day);
    const normalizedStart = normalizeToISTBoundary(day, 'start');
    const normalizedEnd = normalizeToISTBoundary(day, 'end');
    if (filters.dateRange.start && !filters.dateRange.end) {
      const start =
        filters.dateRange.start > normalizedStart ? normalizedStart : filters.dateRange.start;
      const end =
        filters.dateRange.start > normalizedStart ? filters.dateRange.start : normalizedEnd;
      const newFilters = { ...filters, dateRange: { start, end }, quickRange: 'all' as const };
      onFiltersChange?.(newFilters);
    } else {
      const newFilters = {
        ...filters,
        dateRange: { start: normalizedStart, end: normalizedEnd },
        quickRange: 'all' as const,
      };
      onFiltersChange?.(newFilters);
    }
    setShowCalendar(false);
  };

  return (
    <div className="w-full">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 flex-1 flex-wrap">
          <Select
            value={filters.quickRange}
            onValueChange={(value) =>
              updateFilter('quickRange', value as FilterState['quickRange'])
            }
          >
            <SelectTrigger className="w-full md:w-36 h-9 rounded-md bg-white/[0.04] border-white/[0.10] text-xs">
              <Calendar className="h-3.5 w-3.5 mr-2" />
              <SelectValue placeholder="All Time" />
            </SelectTrigger>
            <SelectContent className="bg-card border-white/[0.10] rounded-lg">
              {quickRangeOptions.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  className="rounded-md text-xs"
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={filters.cameraId}
            onValueChange={(value) => updateFilter('cameraId', value)}
          >
            <SelectTrigger className="w-full md:w-36 h-9 rounded-md bg-white/[0.04] border-white/[0.10] text-xs">
              <Camera className="h-3.5 w-3.5 mr-2" />
              <SelectValue placeholder="All Cameras" />
            </SelectTrigger>
            <SelectContent className="bg-card border-white/[0.10] rounded-lg">
              <SelectItem value="all" className="rounded-md text-xs">
                All Cameras
              </SelectItem>
              {cameras.map((camera) => (
                <SelectItem key={camera.id} value={camera.id} className="rounded-md text-xs">
                  {camera.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={filters.detectionType}
            onValueChange={(value: string) =>
              updateFilter('detectionType', value as FilterState['detectionType'])
            }
          >
            <SelectTrigger className="w-full md:w-32 h-9 rounded-md bg-white/[0.04] border-white/[0.10] text-xs">
              <SelectValue placeholder="Event Type" />
            </SelectTrigger>
            <SelectContent className="bg-card border-white/[0.10] rounded-lg">
              <SelectItem value="all" className="rounded-md text-xs">
                All Events
              </SelectItem>
              <SelectItem value="motion" className="rounded-md text-xs">
                Motion
              </SelectItem>
              <SelectItem value="person" className="rounded-md text-xs">
                Person
              </SelectItem>
              <SelectItem value="face" className="rounded-md text-xs">
                Face
              </SelectItem>
              <SelectItem value="vehicle" className="rounded-md text-xs">
                Vehicle
              </SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={filters.jevUrgent ?? 'all'}
            onValueChange={(val: string) => updateFilter('jevUrgent', val as FilterState['jevUrgent'])}
          >
            <SelectTrigger className="w-full md:w-32 h-9 rounded-md bg-white/[0.04] border-white/[0.10] text-xs">
              <SelectValue placeholder="JEV" />
            </SelectTrigger>
            <SelectContent className="bg-card border-white/[0.10] rounded-lg">
              <SelectItem value="all" className="rounded-md text-xs">
                All JEV
              </SelectItem>
              <SelectItem value="true" className="rounded-md text-xs">
                Urgent
              </SelectItem>
              <SelectItem value="false" className="rounded-md text-xs">
                Not Urgent
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Popover open={showCalendar} onOpenChange={setShowCalendar}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  'h-9 text-xs',
                  filters.dateRange.start ? '' : 'text-muted-foreground',
                )}
              >
                <Calendar className="h-3.5 w-3.5 mr-1.5" />
                {filters.dateRange.start ? (
                  <span>
                    {format(filters.dateRange.start, 'MMM d')}
                    {filters.dateRange.end ? ` - ${format(filters.dateRange.end, 'MMM d')}` : ''}
                  </span>
                ) : (
                  <span>Calendar</span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-auto p-0 rounded-lg bg-card border-white/[0.10]"
              align="end"
            >
              <div className="p-3 hairline-bottom flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setCalendarMonth(subMonths(calendarMonth, 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
                <span className="text-xs font-medium">{format(calendarMonth, 'MMMM yyyy')}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setCalendarMonth(addMonths(calendarMonth, 1))}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="grid grid-cols-7 gap-0.5 p-2">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, i) => (
                  <div key={i} className="text-center text-xs text-muted-foreground py-1">
                    {day}
                  </div>
                ))}
                {calendarDays.map((day, i) => {
                  const dateKey = format(day, 'yyyy-MM-dd');
                  const dayData = calendarData[dateKey];
                  return (
                    <button
                      key={i}
                      onClick={() => handleCalendarDayClick(day)}
                      className={cn(
                        'relative h-8 w-8 rounded-full text-xs transition-[background-color,opacity] duration-200',
                        getDayClasses(day),
                        !isSameMonth(day, calendarMonth) && 'opacity-30',
                      )}
                      disabled={!isSameMonth(day, calendarMonth)}
                    >
                      {format(day, 'd')}
                      {dayData && dayData.count > 0 && (
                        <span className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] text-muted-foreground">
                          {dayData.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="p-2 hairline-top flex items-center justify-between text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-primary/20" />
                  <span>Events</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                  <span>Today</span>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {activeFilterCount > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-9 text-xs text-muted-foreground"
              onClick={clearAllFilters}
            >
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
