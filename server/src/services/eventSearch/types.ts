export interface EventSearchFilters {
  startDate?: string;
  endDate?: string;
  cameraId?: string;
  eventType?: string;
  confidence?: string;
  faceStatus?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'ASC' | 'DESC';
}

export interface EventSearchResponse {
  events: any[];
  pagination: {
    page: number;
    pageSize: number;
    totalEvents: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}

export interface ListEnhancedFilters {
  page?: string;
  pageSize?: string;
  event_type?: string;
  camera_id?: string;
  start_date?: string;
  end_date?: string;
  searchQuery?: string;
  sortBy?: string;
  min_confidence?: string;
  max_confidence?: string;
  face_status?: string;
  /** Filter by stored JEV urgency: 'true' | 'false' | 'all'. */
  jev_urgent?: string;
}

export interface DetectionEventFilters {
  limit?: number;
  type?: string;
  cameraId?: string;
  startDate?: string;
  endDate?: string;
}
