// Throwaway harness so the sphere can be LOOKED at without opening a call and
// without spending someone else's afternoon being my eyes. Not part of the app.
import { createRoot } from 'react-dom/client';
import { CallOrb3D } from './components/chat/CallOrb3D';

const FIELD = [
  // The reference read properly this time: it is not pools of light, it is one
  // broad diagonal BEAM crossing the surface from lower left to upper right,
  // with the corners falling into deep red. Beam plus vignette. Earlier passes
  // kept adding soft pools, which averages to an even field — the exact thing
  // the reference is not. Layers paint first-on-top, so the corner darkening is
  // listed first and the base last.
  'radial-gradient(ellipse 62% 56% at 4% 2%, rgba(122, 20, 4, 0.62) 0%, transparent 62%)',
  'radial-gradient(ellipse 72% 62% at 98% 98%, rgba(138, 26, 6, 0.52) 0%, transparent 64%)',
  'linear-gradient(126deg, transparent 10%, rgba(255, 150, 82, 0.34) 34%, rgba(255, 198, 146, 0.46) 50%, rgba(255, 142, 70, 0.24) 66%, transparent 90%)',
  'radial-gradient(ellipse 88% 68% at 74% 16%, #F4581F 0%, transparent 66%)',
  'linear-gradient(160deg, #E8410F 0%, #D2340C 52%, #E04A1A 100%)',
].join(', ');

createRoot(document.getElementById('root')!).render(
  <div style={{ background: FIELD, height: '100vh', display: 'grid', placeItems: 'center' }}>
    <div style={{ position: 'relative', width: 260, height: 260 }}>
      <CallOrb3D phase="listening" level={0.4} />
    </div>
  </div>,
);
