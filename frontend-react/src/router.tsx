import { createMemoryRouter, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ChatPage } from '@/pages/ChatPage';
import { ModelsPage } from '@/pages/ModelsPage';
import { ExtensionsPage } from '@/pages/ExtensionsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { StubPage } from '@/pages/StubPage';
import { MemoryGraphPage } from '@/pages/MemoryGraphPage';

export const router = createMemoryRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      { path: 'chat',     element: <ChatPage /> },
      { path: 'chat/:id', element: <ChatPage /> },
      { path: 'models',     element: <ModelsPage /> },
      { path: 'extensions', element: <ExtensionsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'skills',        element: <StubPage title="Skills" message="Coming in v0.2" /> },
      { path: 'memory-graph',  element: <MemoryGraphPage /> },
    ],
  },
]);
