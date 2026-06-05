# Chat/Agent Toggle Design

**Date:** 2026-06-05  
**Status:** Approved

## Goal

Remove the separate Agents tab. Add a `Chat | Agent` toggle pill to the ChatInput toolbar so users can switch inference backends without leaving the chat UI. When toggled to Agent, messages route through the Feral Agent sidecar (Bun/TS via Tauri IPC). When toggled to Chat, normal local-model / cloud inference applies.

Reference implementation: [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) — same two-pill toggle pattern, same localStorage persistence, same per-send routing decision.

---

## Architecture

### Mode State — `useUI` store

Add two fields to the existing `useUI` Zustand store:

```ts
inputMode: 'chat' | 'agent'   // default: 'chat', persisted to localStorage
setInputMode: (m: 'chat' | 'agent') => void
```

Persistence: extend the existing `useUI` persist config (or add a manual `localStorage` read/write) so the toggle survives page reloads — same pattern as Odysseus's `Storage.loadToggleState()`.

### Toggle UI — `ChatInput`

Two pill buttons added to the **right side of the bottom toolbar** (left of the Send button), inside a `.mode-toggle` wrapper:

```tsx
<div className={cn('mode-toggle', inputMode === 'chat' && 'mode-chat')}>
  <button id="mode-agent-btn" className={cn('mode-toggle-btn', inputMode === 'agent' && 'active')}>Agent</button>
  <button id="mode-chat-btn"  className={cn('mode-toggle-btn', inputMode === 'chat'  && 'active')}>Chat</button>
</div>
```

CSS uses a `::before` pseudo-element that slides between the two buttons (translated 100% when chat is active). Exact same technique as Odysseus — pure CSS animation, no JS transitions needed. Styled with Feral's existing CSS variables (`--border`, `--fg`, `var(--brand)`).

The toggle reads `useUI.inputMode` and calls `setInputMode` on click. No local state inside `ChatInput`.

### Send Routing — `ChatPage`

`ChatPage` reads `inputMode` and conditionally:

- Passes `sendFn={feralSend}` to `ChatInput` when `inputMode === 'agent'`
- Passes `alwaysEnabled={true}` when `inputMode === 'agent'` (Feral Agent provides its own inference)
- Renders `<FeralGlobalMount />` when `inputMode === 'agent'`

`FeralGlobalMount` is a null-rendering component whose sole job is calling `useFeralGlobal()`. This keeps the Feral lifecycle listeners (sidecar ready, model_set, model_error) active exactly when needed without mounting the entire `AgentChat` tree.

`feralSend` is `useFeralSendMessage(sessionId)` — already handles streaming, persistence, auto-title, and conversation tagging with `agent_id`.

### Auto-switch on Conversation Open

When `ChatPage` loads a conversation via `:id` param and that conversation has `agent_id` set, it calls `setInputMode('agent')` before rendering. This is the one place where the toggle is driven by data rather than user click — it ensures the Feral path is active when reopening an agent conversation from the sidebar.

Also ensures `useAgent.getState().current` is set: if null, calls `useAgent.getState().refresh()` and selects the first agent. This gives `useFeralSendMessage` a valid agent id to tag new messages with.

### Feral Model Auto-load

When the user switches to Agent mode and `useFeralStore.getState().modelConfig` has no model loaded, the toggle switch triggers `useFeralStore.getState().fetchModelConfig()`. If the sidecar reports no model, the existing `model_error` path in `useFeralStore` handles surfacing the error. The auto-select of most-compatible model is handled inside the Feral Agent sidecar itself (already implemented) — frontend just needs to not block on it.

---

## Files Changed

### Modified
- `frontend-react/src/stores/ui.ts` — add `inputMode` + `setInputMode` + persist
- `frontend-react/src/components/chat/ChatInput.tsx` — add toggle pill UI
- `frontend-react/src/pages/ChatPage.tsx` — wire `sendFn`, `alwaysEnabled`, `FeralGlobalMount`, auto-switch logic
- `frontend-react/src/components/layout/Sidebar.tsx` — remove `Agents` from MENU; update `RecentRow` to route agent convs to `/chat/:id`
- `frontend-react/src/router.tsx` — remove `/agents` and `/agents/:id` routes

### New
- `frontend-react/src/components/chat/FeralGlobalMount.tsx` — null component, calls `useFeralGlobal()`

### Deleted
- `frontend-react/src/pages/AgentsPage.tsx`
- `frontend-react/src/components/agents/AgentGate.tsx`
- `frontend-react/src/components/agents/AgentsPageLayout.tsx`
- `frontend-react/src/components/agents/AgentChat.tsx`
- `frontend-react/src/components/agents/AgentHeader.tsx`

---

## Data Flow

```
User clicks "Agent" pill
  → setInputMode('agent') → persisted to localStorage
  → ChatPage reads inputMode === 'agent'
  → renders <FeralGlobalMount /> (mounts useFeralGlobal listeners)
  → ensures useAgent.current is set
  → passes sendFn={feralSend} + alwaysEnabled to ChatInput

User sends message
  → ChatInput calls sendFn(text) = feralSend(text)
  → feralSend invokes feral_send_message Tauri IPC
  → streams via feral://agent-output events
  → persists conversation with agent_id tag
  → conversation appears in sidebar with Bot icon
```

---

## What Does NOT Change

- `useSendMessage` (normal chat path) — untouched
- `useFeralSendMessage` / `useFeralStream` / `feralAgentStream` — untouched
- `useFeralStore` — untouched
- `useAgent` store — untouched (still used for agent id + model tracking)
- `FeralModelSelector` — kept, accessible via Settings or a future agent info area
- Sidebar's `RecentRow` Bot icon for agent conversations — kept
- All agent conversation data on disk — no migration needed (`agent_id` field unchanged)

---

## Out of Scope

- Multi-agent picker (selecting between agents from the toggle) — future work
- AgentHeader agent name display in chat — removed; accessible via Settings
- Research mode toggle (future Odysseus-inspired addition)
