// Throwaway harness so the sphere can be LOOKED at without opening a call and
// without spending someone else's afternoon being my eyes. Not part of the app.
import { createRoot } from 'react-dom/client';
import { CallOrb3D } from './components/chat/CallOrb3D';

const FIELD = [
  'radial-gradient(ellipse 95% 75% at 76% 4%, #E8834F 0%, transparent 62%)',
  'radial-gradient(ellipse 75% 62% at 6% 92%, #D96A45 0%, transparent 58%)',
  'radial-gradient(ellipse 130% 95% at 32% 44%, #B4482A 0%, transparent 72%)',
  'linear-gradient(150deg, #C4522F 0%, #A63C22 58%, #BE5A34 100%)',
].join(', ');

createRoot(document.getElementById('root')!).render(
  <div style={{ background: FIELD, height: '100vh', display: 'grid', placeItems: 'center' }}>
    <div style={{ position: 'relative', width: 260, height: 260 }}>
      <CallOrb3D phase="listening" level={0.4} />
    </div>
  </div>,
);
