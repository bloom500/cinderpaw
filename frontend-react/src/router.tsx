import { createMemoryRouter, Navigate } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { ChatPage } from '@/pages/ChatPage';
import { StubPage } from '@/pages/StubPage';

export const router = createMemoryRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/chat" replace /> },
      { path: 'chat',     element: <ChatPage /> },
      { path: 'chat/:id', element: <ChatPage /> },
      { path: 'models',   element: <StubPage title="Models"   message="Coming in spec 2" /> },
      { path: 'agents',   element: <StubPage title="Agents"   message="Coming in spec 3" /> },
      { path: 'settings', element: <StubPage title="Settings" message="Coming in spec 4" /> },
      { path: 'skills',   element: <StubPage title="Skills"   message="Coming in v0.2" /> },
    ],
  },
]);
