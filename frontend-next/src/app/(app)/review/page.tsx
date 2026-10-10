import { Suspense } from 'react';
import type { Metadata } from 'next';
import ReviewPage from '@/views/ReviewPage';
import RouteLoading from '@/components/layout/LoadingRoute';

export const metadata: Metadata = { title: 'Review' };

export default function ReviewRoute() {
  return <Suspense fallback={<RouteLoading />}><ReviewPage /></Suspense>;
}