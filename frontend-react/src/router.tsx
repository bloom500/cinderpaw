import { lazy, Suspense } from 'react';
import { createMemoryRouter, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ChatPage } from '@/pages/ChatPage';

// Non-chat pages are code-split so their dependencies (vis-network alone is
// several hundred KB) stay out of the startup bundle. Chat is the landing
// page and stays statically imported. The Suspense fallback is empty: these
// chunks load from local disk in single-digit ms, a spinner would only flash.
const ModelsPage      = lazy(() => import('@/pages/ModelsPage').then((m) => ({ default: m.ModelsPage })));
const ExtensionsPage  = lazy(() => import('@/pages/ExtensionsPage').then((m) => ({ default: m.ExtensionsPage })));
const SettingsPage    = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const MemoryGraphPage = lazy(() => import('@/pages/MemoryGraphPage').then((m) => ({ default: m.MemoryGraphPage })));

const lazyPage = (page: React.ReactNode) => <Suspense fallback={null}>{page}</Suspense>;

export const router = createMemoryRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      { path: 'chat',     element: <ChatPage /> },
      { path: 'chat/:id', element: <ChatPage /> },
      { path: 'models',     element: lazyPage(<ModelsPage />) },
      { path: 'extensions', element: lazyPage(<ExtensionsPage />) },
      { path: 'settings', element: lazyPage(<SettingsPage />) },
      // No '/skills' route: the sidebar's Skills item opens SkillHubDrawer
      // directly; the old StubPage route was unreachable dead weight.
      { path: 'memory-graph', element: lazyPage(<MemoryGraphPage />) },
    ],
  },
]);
