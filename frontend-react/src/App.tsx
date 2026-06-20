import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { tauri } from './lib/tauri';

export default function App() {
  // Fetch the embedding model for Fractal Memory Search once on startup. The
  // Rust command is idempotent (no-op if already on disk) and downloads in the
  // background; on failure (offline) recall simply stays on FTS5. Fire-and-
  // forget — never blocks the UI.
  useEffect(() => {
    void tauri.raw.downloadEmbeddingModel().catch(() => {});
  }, []);

  return <RouterProvider router={router} />;
}
