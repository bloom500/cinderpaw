# Hero Input Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a chat is empty, the input pill is centered on screen with a greeting + 3 random suggestion pills; on first message send it slides smoothly to the bottom.

**Architecture:** The `ChatInput` wrapper in `ChatPage` is always `absolute inset-x-0 bottom-0`. When `isEmpty=true`, a `useLayoutEffect` measures the container and applies a negative `translateY` to visually center the input. A CSS transition on `transform` animates the slide-down when `isEmpty` becomes false. `NewChatEmptyState` occupies the space with an absolute overlay (greeting above, suggestion pills below) and fades out via an opacity transition. A `useImperativeHandle` on `ChatInput` lets suggestion clicks fill + focus the input without lifting state.

**Tech Stack:** React 18, Tailwind CSS, Zustand, react-router-dom, lucide-react

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `frontend-react/src/lib/suggestions.ts` | **Create** | Static prompt list + `getRandomSuggestions(n)` |
| `frontend-react/src/components/chat/EmptyStates.tsx` | **Modify** | Redesign `NewChatEmptyState` with greeting, fade, suggestion pills |
| `frontend-react/src/components/chat/ChatInput.tsx` | **Modify** | Add `forwardRef` + `ChatInputHandle` (setText/focus) |
| `frontend-react/src/pages/ChatPage.tsx` | **Modify** | Centering animation logic, wire suggestion callback |

---

### Task 1: Suggestion prompts data

**Files:**
- Create: `frontend-react/src/lib/suggestions.ts`

- [ ] **Step 1: Create the file**

```ts
const PROMPTS = [
  'Explain this code to me',
  'Write a unit test for this function',
  'Debug: why is this returning undefined?',
  'Refactor this for readability',
  'Translate this to Python',
  'Summarize this in 3 bullet points',
  'Write a regex that matches emails',
  'What are the trade-offs between X and Y?',
  'Draft a commit message for these changes',
  'How do I reverse a linked list?',
  'Explain async/await vs promises',
  'Write a SQL query to find duplicates',
  'How do I center a div in CSS?',
  'Give me a shell one-liner to find large files',
  'What does this error mean?',
];

export function getRandomSuggestions(n: number): string[] {
  const shuffled = [...PROMPTS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend-react/src/lib/suggestions.ts
git commit -m "feat(chat): add suggestion prompts data"
```

---

### Task 2: Redesign NewChatEmptyState

**Files:**
- Modify: `frontend-react/src/components/chat/EmptyStates.tsx`

The new `NewChatEmptyState` is an `absolute inset-0` overlay. It renders a vertically-centered column with:
- Greeting text above (offset up to leave room for input)
- Suggestion pills below (offset down to appear under input)

It accepts `isEmpty: boolean` for its own fade-out and `onSuggestion` callback.

The greeting sits in the upper half via `pb-32` on the centering flex container (pushes content up), and suggestion pills sit below via `pt-24` in a second absolute row anchored to `top-1/2`.

- [ ] **Step 1: Rewrite EmptyStates.tsx**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { getRandomSuggestions } from '@/lib/suggestions';
import { cn } from '@/lib/utils';

export function NoModelEmptyState() {
  const navigate = useNavigate();
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-text-muted px-6">
      <h2 className="text-xl text-text-secondary mb-2">No model selected</h2>
      <p className="mb-6 text-center">Load a local model or configure a cloud key to start chatting.</p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={() => navigate('/models')}>
          Open Models
        </Button>
        <Button variant="outline" onClick={() => navigate('/settings')}>
          Cloud Keys
        </Button>
      </div>
    </div>
  );
}

interface NewChatEmptyStateProps {
  isEmpty: boolean;
  onSuggestion: (text: string) => void;
}

export function NewChatEmptyState({ isEmpty, onSuggestion }: NewChatEmptyStateProps) {
  const [suggestions] = useState(() => getRandomSuggestions(3));

  return (
    <div
      className={cn(
        'absolute inset-0 pointer-events-none transition-opacity duration-200',
        isEmpty ? 'opacity-100' : 'opacity-0',
      )}
    >
      {/* Greeting — centered but pushed up to sit above the input */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pb-28">
        <h1 className="text-2xl font-semibold text-text-primary select-none">
          What can I help you with?
        </h1>
      </div>

      {/* Suggestion pills — sit below the input */}
      <div
        className={cn(
          'absolute inset-x-0 flex flex-wrap justify-center gap-2 px-6 pointer-events-auto',
          'top-1/2 pt-16',
        )}
      >
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSuggestion(s)}
            className="px-4 py-1.5 rounded-full border border-border-default bg-bg-surface hover:bg-bg-hover text-sm text-text-secondary transition-colors cursor-pointer"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend-react/src/components/chat/EmptyStates.tsx
git commit -m "feat(chat): redesign NewChatEmptyState with greeting and suggestion pills"
```

---

### Task 3: Add imperative handle to ChatInput

**Files:**
- Modify: `frontend-react/src/components/chat/ChatInput.tsx`

Add `forwardRef` so `ChatPage` can call `setText` + `focus` on suggestion click, without lifting text state.

- [ ] **Step 1: Add handle types and forwardRef wrap**

At the top of the file, add after the imports:

```tsx
import { useEffect, useRef, useState, forwardRef, useImperativeHandle, type KeyboardEvent } from 'react';
```

Replace the existing `import { useEffect, useRef, useState, type KeyboardEvent } from 'react';`.

- [ ] **Step 2: Add the handle interface before the component**

Add this block right before `export function ChatInput()`:

```tsx
export interface ChatInputHandle {
  setText: (text: string) => void;
  focus: () => void;
}
```

- [ ] **Step 3: Convert to forwardRef**

Replace:
```tsx
export function ChatInput() {
```
with:
```tsx
export const ChatInput = forwardRef<ChatInputHandle, Record<string, never>>(function ChatInput(_props, ref) {
```

And close the function with an extra `)` at the end of the file (after the closing `}`):

```tsx
}); // closes forwardRef
```

- [ ] **Step 4: Wire useImperativeHandle inside the component**

Add this block directly after the `taRef` and `send` lines (around line 48):

```tsx
  useImperativeHandle(ref, () => ({
    setText: (t: string) => {
      setText(t);
      setTimeout(() => taRef.current?.focus(), 0);
    },
    focus: () => taRef.current?.focus(),
  }));
```

- [ ] **Step 5: Verify the file compiles — run type check**

```bash
cd frontend-react && npx tsc --noEmit
```

Expected: no errors related to ChatInput.

- [ ] **Step 6: Commit**

```bash
git add frontend-react/src/components/chat/ChatInput.tsx
git commit -m "feat(chat): add imperative handle (setText/focus) to ChatInput"
```

---

### Task 4: Wire ChatPage — centering animation

**Files:**
- Modify: `frontend-react/src/pages/ChatPage.tsx`

This is where the animation lives. Key points:

- A `containerRef` on the flex-1 div measures available height.
- An `inputWrapperRef` on the absolute div around `ChatInput` measures input height.
- `useLayoutEffect` recomputes `translateY` whenever `isEmpty` changes.
- When `isEmpty=true`: `translateY = -(containerH / 2 - inputH / 2)` (slides up to center).
- When `isEmpty=false`: `translateY = 0` (rests at bottom).
- CSS `transition: transform 350ms cubic-bezier(0.4, 0, 0.2, 1)` on the wrapper.
- `chatInputRef` (a `useRef<ChatInputHandle>`) is forwarded to `ChatInput` for suggestion clicks.
- `NewChatEmptyState` receives `isEmpty` for its own fade-out.

- [ ] **Step 1: Rewrite ChatPage.tsx**

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useChat } from '@/stores/chat';
import { useConversations } from '@/stores/conversations';
import { useModel } from '@/stores/model';
import { ChatHeader } from '@/components/chat/ChatHeader';
import { MessageList } from '@/components/chat/MessageList';
import { ChatInput, type ChatInputHandle } from '@/components/chat/ChatInput';
import { NoModelEmptyState, NewChatEmptyState } from '@/components/chat/EmptyStates';

export function ChatPage() {
  const { id } = useParams();
  const loaded      = useModel((s) => s.loaded);
  const cloudModel  = useModel((s) => s.cloudModel);
  const messages    = useChat((s) => s.messages);
  const loadingConversation = useConversations((s) => s.loadingConversation);

  const hasModel = !!loaded || !!cloudModel;
  const isEmpty  = messages.length === 0 && hasModel;

  const containerRef    = useRef<HTMLDivElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const chatInputRef    = useRef<ChatInputHandle>(null);
  const [translateY, setTranslateY] = useState(0);

  // Recompute centering offset whenever isEmpty changes
  useLayoutEffect(() => {
    const container = containerRef.current;
    const wrapper   = inputWrapperRef.current;
    if (!container || !wrapper) return;

    if (isEmpty) {
      const containerH = container.offsetHeight;
      const inputH     = wrapper.offsetHeight;
      setTranslateY(-(containerH / 2 - inputH / 2));
    } else {
      setTranslateY(0);
    }
  }, [isEmpty]);

  // Initial data hydration
  useEffect(() => {
    void useConversations.getState().refresh();
    void useModel.getState().refresh();
  }, []);

  // Open conversation when route changes
  useEffect(() => {
    if (id) void useConversations.getState().open(id);
  }, [id]);

  // Listen for Ctrl+N / ⌘N from useGlobalHotkeys
  useEffect(() => {
    const handler = () => useConversations.getState().newChat();
    window.addEventListener('feral:new-chat', handler);
    return () => window.removeEventListener('feral:new-chat', handler);
  }, []);

  const handleSuggestion = (text: string) => {
    chatInputRef.current?.setText(text);
  };

  return (
    <div className="flex flex-col h-full">
      <ChatHeader />

      {/* Positioning context for absolute children */}
      <div ref={containerRef} className="relative flex-1 overflow-hidden">
        {loadingConversation && (
          <div className="absolute inset-x-0 top-0 h-0.5 bg-brand animate-pulse z-10" />
        )}

        {/* Content: messages, no-model state, or empty overlay */}
        {messages.length > 0 ? (
          <MessageList />
        ) : !hasModel ? (
          <NoModelEmptyState />
        ) : (
          <NewChatEmptyState isEmpty={isEmpty} onSuggestion={handleSuggestion} />
        )}

        {/* Input — always at bottom-0, translated up when empty */}
        {hasModel || messages.length > 0 ? (
          <div
            ref={inputWrapperRef}
            style={{
              transform: `translateY(${translateY}px)`,
              transition: 'transform 350ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
            className="absolute inset-x-0 bottom-0 z-20"
          >
            <ChatInput ref={chatInputRef} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run type check**

```bash
cd frontend-react && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend-react/src/pages/ChatPage.tsx
git commit -m "feat(chat): hero-to-bar input animation — centered on empty, slides to bottom on send"
```

---

### Task 5: Visual polish pass

After seeing it running, adjust offsets if greeting/pills aren't perfectly positioned around the input.

- [ ] **Step 1: Check `pb-28` on greeting div in EmptyStates.tsx**

The greeting is pushed up by `pb-28` (7rem = 112px). The input is ~72px tall. Half of that is ~36px. So the greeting sits ~76px above center. Adjust `pb-28` → `pb-24` or `pb-32` to taste.

- [ ] **Step 2: Check `pt-16` on suggestion pills div**

`pt-16` = 64px below center. The input bottom edge is at center + ~36px, so pills start ~28px below the input. Adjust to `pt-20` (80px) if they overlap.

- [ ] **Step 3: Verify animation feel**

Open the app, confirm:
- Empty chat: input is centered, greeting above, pills below.
- Type a message and send: greeting fades, input slides to bottom in ~350ms.
- Navigate back to a new chat: input re-centers.

- [ ] **Step 4: Commit any polish tweaks**

```bash
git add frontend-react/src/components/chat/EmptyStates.tsx
git commit -m "fix(chat): tune hero input vertical offsets"
```
