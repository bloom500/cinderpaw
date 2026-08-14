// Throwaway harness so the sphere can be LOOKED at without opening a call and
// without spending someone else's afternoon being my eyes. Not part of the app.
import { createRoot } from 'react-dom/client';
import { CallOrb3D } from './components/chat/CallOrb3D';

const FIELD = [
  'linear-gradient(118deg, transparent 26%, rgba(255,214,170,0.30) 44%, rgba(255,180,120,0.10) 56%, transparent 70%)',
  'radial-gradient(ellipse 80% 62% at 88% 2%, #FF9A4E 0%, transparent 58%)',
  'radial-gradient(ellipse 70% 58% at 4% 96%, #F4713F 0%, transparent 56%)',
  'radial-gradient(ellipse 120% 90% at 34% 46%, #E4451C 0%, transparent 74%)',
  'linear-gradient(150deg, #EF5423 0%, #D63A14 56%, #E8632C 100%)',
].join(', ');

createRoot(document.getElementById('root')!).render(
  <div style={{ background: FIELD, height: '100vh', display: 'grid', placeItems: 'center' }}>
    <div style={{ position: 'relative', width: 260, height: 260 }}>
      <CallOrb3D phase="listening" level={0.4} />
    </div>
  </div>,
);
