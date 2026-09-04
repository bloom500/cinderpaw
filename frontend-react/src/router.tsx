import { lazy, Suspense } from 'react';
import { createMemoryRouter, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ChatPage } from '@/pages/ChatPage';

// Non-chat pages are code-split so their dependencies (Fractal: WebGL2 +
// node overlay code; Settings: per-tab forms) stay out of the startup bundle.
// Chat is the landing page and stays statically imported. The Suspense
// fallback is empty: these chunks load from local disk in single-digit ms,
// a spinner would only flash.
const ChatsPage       = lazy(() => import('@/pages/ChatsPage').then((m) => ({ default: m.ChatsPage })));
const ProjectsPage    = lazy(() => import('@/pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })));
const ModelsPage      = lazy(() => import('@/pages/ModelsPage').then((m) => ({ default: m.ModelsPage })));
const SettingsPage    = lazy(() => import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

const lazyPage = (page: React.ReactNode) => <Suspense fallback={null}>{page}</Suspense>;

export const router = createMemoryRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      { path: 'chat',     element: <ChatPage /> },
      { path: 'chat/:id', element: <ChatPage /> },
      { path: 'chats',    element: lazyPage(<ChatsPage />) },
      { path: 'projects', element: lazyPage(<ProjectsPage />) },
      { path: 'models',     element: lazyPage(<ModelsPage />) },
      { path: 'settings', element: lazyPage(<SettingsPage />) },
      // Phase 5 S1. These three were top-level pages whose ONLY entry point was
      // the sidebar, which Phase 5 deletes. They are now Settings categories,
      // and the routes stay alive as redirects so a deep link, a bookmark or
      // the agent navigating on its own does not land on nothing.
      // No '/skills' route ever existed: Skills is a drawer, opened from
      // Settings -> Capabilities now that the rail is going.
      { path: 'extensions',    element: <Navigate to="/settings?cat=capabilities" replace /> },
      { path: 'connectors',    element: <Navigate to="/settings?cat=accounts" replace /> },
      { path: 'memory-layers', element: <Navigate to="/settings?cat=memory" replace /> },
      { path: 'memory-graph',  element: <Navigate to="/settings?cat=memory" replace /> },
    ],
  },
]);
