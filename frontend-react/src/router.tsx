import { createMemoryRouter, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ChatPage } from '@/pages/ChatPage';
import { ModelsPage } from '@/pages/ModelsPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { StubPage } from '@/pages/StubPage';

export const router = createMemoryRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      { path: 'chat',     element: <ChatPage /> },
      { path: 'chat/:id', element: <ChatPage /> },
      { path: 'models',   element: <ModelsPage /> },
      { path: 'agents',   element: <StubPage title="Agents"   message="Coming in spec 3" /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'skills',   element: <StubPage title="Skills"   message="Coming in v0.2" /> },
    ],
  },
]);
