# Chat/Agent Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the separate Agents tab with a `Chat | Agent` toggle pill on the ChatInput toolbar so both inference paths live in a single ChatPage.

**Architecture:** Add `inputMode` to the persisted `useUI` store; render a toggle in `ChatInput`; wire `ChatPage` to conditionally pass `sendFn={feralSend}` + `alwaysEnabled` and mount `FeralGlobalMount` (a null component that keeps `useFeralGlobal` listeners alive); delete the five agent-specific page/component files and clean up the sidebar and router.

**Tech Stack:** React 18, Zustand (persist middleware), React Router v6, Tauri IPC, Tailwind CSS, TypeScript.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `frontend-react/src/stores/ui.ts` | Add `inputMode` field + persist it |
| Create | `frontend-react/src/components/chat/FeralGlobalMount.tsx` | Null component, calls `useFeralGlobal()` |
| Modify | `frontend-react/src/components/chat/ChatInput.tsx` | Add toggle pill UI |
| Modify | `frontend-react/src/pages/ChatPage.tsx` | Wire sendFn, alwaysEnabled, FeralGlobalMount, auto-switch on conv open |
| Modify | `frontend-react/src/components/layout/Sidebar.tsx` | Remove Agents menu item; route agent convs to `/chat/:id` |
| Modify | `frontend-react/src/router.tsx` | Remove `/agents` and `/agents/:id` routes |
| Delete | `frontend-react/src/pages/AgentsPage.tsx` | — |
| Delete | `frontend-react/src/components/agents/AgentGate.tsx` | — |
| Delete | `frontend-react/src/components/agents/AgentsPageLayout.tsx` | — |
| Delete | `frontend-react/src/components/agents/AgentChat.tsx` | — |
| Delete | `frontend-react/src/components/agents/AgentHeader.tsx` | — |

---

## Task 1: Add `inputMode` to `useUI` store

**Files:**
- Modify: `frontend-react/src/stores/ui.ts`

- [ ] **Step 1: Add the type and fields to the interface**

Open `frontend-react/src/stores/ui.ts`. Add `InputMode` type and two fields to `UIStore`:

```ts
// After line 8 (after LangPref)
export type InputMode = 'chat' | 'agent';
```

In the `UIStore` interface, add after `skillsOpen`/`closeSkills`:

```ts
  inputMode: InputMode;
  setInputMode: (m: InputMode) => void;
```

- [ ] **Step 2: Add the implementation to the store factory**

Inside the `persist(...)` factory (after `closeSkills: () => set({ skillsOpen: false }),`), add:

```ts
      inputMode: 'chat',
      setInputMode: (inputMode) => set({ inputMode }),
```

- [ ] **Step 3: Add `inputMode` to `partialize`**

In the `partialize` object (around line 83), add `inputMode`:

```ts
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        theme: s.theme,
        language: s.language,
        reasoningMode: s.reasoningMode,
        enabledTools: s.enabledTools,
        inputMode: s.inputMode,
      }),
```

- [ ] **Step 4: Type-check**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1 | Select-String "ui.ts"
```

Expected: no errors mentioning `ui.ts`.

- [ ] **Step 5: Commit**

```powershell
git add frontend-react/src/stores/ui.ts
git commit -m "feat(store): add inputMode to useUI store"
```

---

## Task 2: Create `FeralGlobalMount` component

**Files:**
- Create: `frontend-react/src/components/chat/FeralGlobalMount.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { useFeralGlobal } from '@/hooks/useFeral';

export function FeralGlobalMount() {
  useFeralGlobal();
  return null;
}
```

- [ ] **Step 2: Type-check**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1 | Select-String "FeralGlobalMount"
```

Expected: no output (no errors).

- [ ] **Step 3: Commit**

```powershell
git add frontend-react/src/components/chat/FeralGlobalMount.tsx
git commit -m "feat(agents): add FeralGlobalMount null component"
```

---

## Task 3: Add Chat/Agent toggle to `ChatInput`

**Files:**
- Modify: `frontend-react/src/components/chat/ChatInput.tsx`

- [ ] **Step 1: Import `useUI` fields**

At the top of `ChatInput.tsx`, the `useUI` import is already present. Add `InputMode` to it:

```ts
import { useUI, type ReasoningMode, type InputMode } from '@/stores/ui';
```

- [ ] **Step 2: Read `inputMode` and `setInputMode` from the store**

Inside the `ChatInput` component body (after the existing `useUI` calls on lines 65–66), add:

```ts
  const inputMode    = useUI((s) => s.inputMode);
  const setInputMode = useUI((s) => s.setInputMode);
```

- [ ] **Step 3: Add the toggle JSX**

In the bottom toolbar `<div className="flex items-center justify-between px-4 pb-3">`, find the right side `<div className="flex items-center gap-2">` (contains Stop/Send button). Add the toggle **before** that div:

```tsx
          {/* Chat / Agent mode toggle */}
          <div className="flex rounded-lg border border-border-default bg-bg-elevated h-7 overflow-hidden shrink-0">
            <button
              type="button"
              onClick={() => setInputMode('agent')}
              className={cn(
                'px-2.5 text-[11px] font-medium transition-colors',
                inputMode === 'agent'
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-muted hover:text-text-secondary',
              )}
            >
              Agent
            </button>
            <button
              type="button"
              onClick={() => setInputMode('chat')}
              className={cn(
                'px-2.5 text-[11px] font-medium transition-colors',
                inputMode === 'chat'
                  ? 'bg-bg-hover text-text-primary'
                  : 'text-text-muted hover:text-text-secondary',
              )}
            >
              Chat
            </button>
          </div>
```

The full `justify-between` row after the change looks like:

```tsx
          <div className="flex items-center justify-between px-4 pb-3">
            <div className="flex gap-1">
              {/* FileAttachButton, ToolsPopover, Brain dropdown — unchanged */}
            </div>
            <div className="flex items-center gap-2">
              {/* Chat / Agent mode toggle */}
              <div className="flex rounded-lg border border-border-default bg-bg-elevated h-7 overflow-hidden shrink-0">
                <button
                  type="button"
                  onClick={() => setInputMode('agent')}
                  className={cn(
                    'px-2.5 text-[11px] font-medium transition-colors',
                    inputMode === 'agent'
                      ? 'bg-bg-hover text-text-primary'
                      : 'text-text-muted hover:text-text-secondary',
                  )}
                >
                  Agent
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('chat')}
                  className={cn(
                    'px-2.5 text-[11px] font-medium transition-colors',
                    inputMode === 'chat'
                      ? 'bg-bg-hover text-text-primary'
                      : 'text-text-muted hover:text-text-secondary',
                  )}
                >
                  Chat
                </button>
              </div>
              {/* Stop / Send button — unchanged */}
              {isStreaming ? ( ... ) : ( ... )}
            </div>
          </div>
```

- [ ] **Step 4: Type-check**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1 | Select-String "ChatInput"
```

Expected: no errors.

- [ ] **Step 5: Commit**

```powershell
git add frontend-react/src/components/chat/ChatInput.tsx
git commit -m "feat(ui): add Chat/Agent mode toggle pill to ChatInput"
```

---

## Task 4: Wire `ChatPage` for agent mode

**Files:**
- Modify: `frontend-react/src/pages/ChatPage.tsx`

This is the core wiring task. `ChatPage` needs to:
1. Read `inputMode` from `useUI`
2. When `inputMode === 'agent'`: pass `sendFn={feralSend}` + `alwaysEnabled` to `ChatInput`, render `<FeralGlobalMount />`
3. Show the input regardless of model when in agent mode
4. When opening a conversation with `agent_id`, auto-set `inputMode = 'agent'` and arm the `reopenSessionId`
5. When switching to agent mode manually (no conv loaded), ensure `useAgent.current` is set

- [ ] **Step 1: Add imports**

Replace the existing import block in `ChatPage.tsx` with:

```ts
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { useProjects } from '@/stores/projects';
import { useUI } from '@/stores/ui';
import { useAgent } from '@/stores/agent';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { MessageList } from '@/components/chat/MessageList';
import { ChatInput, type ChatInputHandle } from '@/components/chat/ChatInput';
import { NoModelEmptyState, NewChatEmptyState } from '@/components/chat/EmptyStates';
import { FeralGlobalMount } from '@/components/chat/FeralGlobalMount';
import { useFeralSendMessage } from '@/hooks/useFeral';
```

- [ ] **Step 2: Read mode and derive `feralSend` inside the component**

Inside `ChatPage`, after the existing `useModel` / `useConversations` reads, add:

```ts
  const inputMode    = useUI((s) => s.inputMode);
  const setInputMode = useUI((s) => s.setInputMode);
  const sessionId    = useChat((s) => s.sessionId);
  const feralSend    = useFeralSendMessage(sessionId);
  const isAgentMode  = inputMode === 'agent';
```

- [ ] **Step 3: Update `hasModel` and `isEmpty` to account for agent mode**

Replace:

```ts
  const hasModel = !!loaded || !!cloudModel;
  const isEmpty  = messages.length === 0 && hasModel;
```

With:

```ts
  const hasModel  = !!loaded || !!cloudModel;
  const canInput  = hasModel || isAgentMode;
  const isEmpty   = messages.length === 0 && canInput;
```

- [ ] **Step 4: Auto-switch on conversation open (agent convs from sidebar)**

Replace the existing `useEffect` that opens a conversation:

```ts
  // Open conversation when route changes
  useEffect(() => {
    if (id) void useConversations.getState().open(id);
  }, [id]);
```

With:

```ts
  // Open conversation when route changes; auto-switch to agent mode
  // if the conversation was created under a Feral Agent.
  useEffect(() => {
    if (!id) return;
    // Arm reopen flag SYNCHRONOUSLY before any await so AgentChat-style
    // effects that fire immediately see it.
    useAgent.getState().setReopenSessionId(id);
    void (async () => {
      await useConversations.getState().open(id);
      const meta = useConversations.getState().list.find((c) => c.id === id);
      if (!meta?.agent_id) {
        useAgent.getState().setReopenSessionId(null);
        return;
      }
      setInputMode('agent');
      await useAgent.getState().refresh();
      const agent = useAgent.getState().list.find((a) => a.id === meta.agent_id);
      if (agent) useAgent.getState().setCurrent(agent.id);
    })();
    return () => {
      useAgent.getState().setReopenSessionId(null);
    };
  }, [id, setInputMode]);
```

- [ ] **Step 5: Clear reopen flag once the session is on screen**

Add a new effect after the one above:

```ts
  // Clear the reopen flag once the target conversation is active.
  const reopenSessionId = useAgent((s) => s.reopenSessionId);
  useEffect(() => {
    if (reopenSessionId && useChat.getState().sessionId === reopenSessionId) {
      useAgent.getState().setReopenSessionId(null);
    }
  }, [reopenSessionId, sessionId]);
```

- [ ] **Step 6: Ensure agent is selected when switching to agent mode without a loaded conv**

Add an effect that runs when `inputMode` changes to `'agent'`:

```ts
  // When the user manually switches to agent mode, ensure an agent is
  // selected so feralSend can tag conversations with agent_id.
  useEffect(() => {
    if (inputMode !== 'agent') return;
    if (useAgent.getState().current) return;
    void useAgent.getState().refresh().then(() => {
      const first = useAgent.getState().list[0];
      if (first) useAgent.getState().setCurrent(first.id);
    });
  }, [inputMode]);
```

- [ ] **Step 7: Update the JSX — `FeralGlobalMount`, `canInput`, `sendFn`/`alwaysEnabled`**

Replace the JSX `return` block entirely:

```tsx
  return (
    <div className="flex flex-col h-full">
      <ChatHeader />

      {isAgentMode && <FeralGlobalMount />}

      {/* Positioning context for absolute children */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        {loadingConversation && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-brand animate-pulse z-10" />
        )}

        {/* Content: messages, no-model state, or empty overlay */}
        {messages.length > 0 ? (
          <MessageList />
        ) : !canInput ? (
          <NoModelEmptyState />
        ) : (
          <NewChatEmptyState isEmpty={isEmpty} onSuggestion={handleSuggestion} />
        )}

        {/* Input — shown whenever canInput (model loaded OR agent mode) */}
        {canInput && (
          <div
            ref={inputWrapperRef}
            style={{
              transform: `translateY(${translateY}px)`,
              transition: 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            className="absolute inset-x-0 bottom-0 z-20 pt-8 bg-gradient-to-t from-bg-primary via-bg-primary/95 to-transparent"
          >
            <ChatInput
              ref={chatInputRef}
              isEmpty={isEmpty}
              sendFn={isAgentMode ? feralSend : undefined}
              alwaysEnabled={isAgentMode}
            />
          </div>
        )}
      </div>
    </div>
  );
```

- [ ] **Step 8: Type-check**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1 | Select-String "ChatPage|FeralGlobalMount|useFeral"
```

Expected: no errors.

- [ ] **Step 9: Commit**

```powershell
git add frontend-react/src/pages/ChatPage.tsx
git commit -m "feat(chat): wire agent mode in ChatPage (sendFn, FeralGlobalMount, auto-switch)"
```

---

## Task 5: Update Sidebar — remove Agents item, fix RecentRow routing

**Files:**
- Modify: `frontend-react/src/components/layout/Sidebar.tsx`

- [ ] **Step 1: Remove `Bot` import and `Agents` from `MENU`**

In `Sidebar.tsx`, the `MENU` array is defined around line 37. Remove the `Agents` entry:

```ts
// Remove this line entirely:
{ icon: Bot, label: 'Agents', shortcut: null, action: 'agents', disabled: false, route: '/agents' },
```

Also remove `Bot` from the lucide import at the top if it is no longer used anywhere else in the file. Check: `Bot` is also used in `RecentRow` (line 629) as the agent conversation icon. Keep the import.

Also remove `'agents'` from the `MenuAction` type union:

```ts
// Before:
type MenuAction = 'newChat' | 'newProject' | 'search' | 'models' | 'settings' | 'skills' | 'agents';

// After:
type MenuAction = 'newChat' | 'newProject' | 'search' | 'models' | 'settings' | 'skills';
```

- [ ] **Step 2: Fix `RecentRow` — route agent convs to `/chat/:id`**

In `RecentRow`, find the click handler (around line 605–615):

```ts
        onClick={() => {
          // Agent-owned conversations must reopen in the Agents tab so the
          // Feral Agent context (system_prompt, tools, streaming) is loaded
          // — otherwise we'd land on ChatPage and the stream would just
          // silently disappear.
          if (conv.agent_id) {
            navigate(`/agents/${conv.id}`);
          } else {
            navigate(`/chat/${conv.id}`);
          }
        }}
```

Replace with:

```ts
        onClick={() => navigate(`/chat/${conv.id}`)}
```

- [ ] **Step 3: Type-check**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1 | Select-String "Sidebar"
```

Expected: no errors.

- [ ] **Step 4: Commit**

```powershell
git add frontend-react/src/components/layout/Sidebar.tsx
git commit -m "feat(sidebar): remove Agents menu item; route all convs through /chat"
```

---

## Task 6: Update router — remove `/agents` routes

**Files:**
- Modify: `frontend-react/src/router.tsx`

- [ ] **Step 1: Remove the agents imports and routes**

Current `router.tsx`:

```ts
import { AgentsPage } from '@/pages/AgentsPage';
...
{ path: 'agents',     element: <AgentsPage /> },
{ path: 'agents/:id', element: <AgentsPage /> },
```

Replace the entire file with:

```ts
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
      { path: 'settings', element: <SettingsPage /> },
      { path: 'skills',   element: <StubPage title="Skills" message="Coming in v0.2" /> },
    ],
  },
]);
```

- [ ] **Step 2: Type-check**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1 | Select-String "router"
```

Expected: no errors.

- [ ] **Step 3: Commit**

```powershell
git add frontend-react/src/router.tsx
git commit -m "feat(router): remove /agents routes"
```

---

## Task 7: Delete obsolete agent page and components

**Files:**
- Delete: `frontend-react/src/pages/AgentsPage.tsx`
- Delete: `frontend-react/src/components/agents/AgentGate.tsx`
- Delete: `frontend-react/src/components/agents/AgentsPageLayout.tsx`
- Delete: `frontend-react/src/components/agents/AgentChat.tsx`
- Delete: `frontend-react/src/components/agents/AgentHeader.tsx`

- [ ] **Step 1: Delete the files**

```powershell
Remove-Item frontend-react/src/pages/AgentsPage.tsx
Remove-Item frontend-react/src/components/agents/AgentGate.tsx
Remove-Item frontend-react/src/components/agents/AgentsPageLayout.tsx
Remove-Item frontend-react/src/components/agents/AgentChat.tsx
Remove-Item frontend-react/src/components/agents/AgentHeader.tsx
```

- [ ] **Step 2: Type-check — confirm no remaining imports of deleted files**

```powershell
cd frontend-react && npx tsc --noEmit 2>&1
```

Expected: zero errors. If any errors appear referencing the deleted files, trace them and remove the import.

- [ ] **Step 3: Commit**

```powershell
git add -A
git commit -m "chore: delete obsolete AgentsPage and agent-specific components"
```

---

## Task 8: Smoke test

No automated tests exist for this UI flow. Verify manually by running the app.

- [ ] **Step 1: Start the dev server**

```powershell
cd frontend-react && npm run dev
```

Or via Tauri:

```powershell
npm run tauri dev
```

- [ ] **Step 2: Verify toggle renders and persists**

1. Open the app → chat input shows `[Agent] [Chat]` pills on the right of the toolbar
2. Click `Agent` → pill highlights `Agent`
3. Refresh the app → `Agent` is still highlighted (persisted in localStorage key `feral-ui`)
4. Click `Chat` → pill highlights `Chat`

- [ ] **Step 3: Verify agent mode sends through Feral Agent**

1. Toggle to `Agent`
2. Type a message and send
3. Confirm response streams in (Feral Agent sidecar must be running)
4. Check sidebar — conversation appears with Bot icon

- [ ] **Step 4: Verify chat mode sends normally**

1. Toggle to `Chat`
2. Send a message (requires local model or cloud key)
3. Confirm response streams normally with no Feral Agent involvement

- [ ] **Step 5: Verify sidebar agent conv reopens in agent mode**

1. Open a previously-created agent conversation from the Recent list
2. Confirm the toggle auto-switches to `Agent`
3. Confirm the conversation history loads
4. Confirm new messages in that conversation go through Feral Agent

- [ ] **Step 6: Confirm `Agents` is gone from sidebar**

Sidebar no longer shows an `Agents` menu item.

- [ ] **Step 7: Final commit if any fixes were needed**

```powershell
git add -A
git commit -m "fix: post-smoke-test corrections"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Remove Agents tab from sidebar → Task 5 + Task 6 + Task 7
- ✅ Chat/Agent toggle on input bar → Task 3
- ✅ Toggle persists across reloads → Task 1 (partialize)
- ✅ Agent mode routes through Feral Agent sidecar → Task 4 (`sendFn={feralSend}`, `alwaysEnabled`)
- ✅ `useFeralGlobal` lifecycle listeners active in agent mode → Task 2 + Task 4 (`<FeralGlobalMount />`)
- ✅ Opening agent conv from sidebar auto-switches toggle → Task 4 (conv open effect)
- ✅ `useAgent.current` set when switching to agent mode → Task 4 (inputMode effect)
- ✅ `reopenSessionId` pattern preserved → Task 4 (Step 4 + Step 5)
- ✅ Delete obsolete components → Task 7

**Placeholder scan:** No TBD, no "similar to", no vague steps — all steps contain exact code.

**Type consistency:**
- `InputMode` defined in Task 1, imported in Task 3 (ChatInput) and used in Task 4 (ChatPage)
- `FeralGlobalMount` defined in Task 2, imported in Task 4
- `feralSend` typed as return of `useFeralSendMessage(sessionId)` which matches `sendFn?: (text: string) => Promise<void>` in `ChatInputProps` ✅
- `canInput` replaces `hasModel` only in ChatPage — `hasModel` still used for model-specific logic ✅
