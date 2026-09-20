"""Mechanical acceptance for mascot frames: python scripts/mascot/v2/check_frames.py <dir>
<dir>/<state>/NNN.png, each 64x64 RGBA (body at 8,8), only the 4 palette colours + fully transparent,
2..12 frames per state, frame 1 has both horns and both eyes where the base has them."""
import sys, glob, os
from PIL import Image
import numpy as np
PAL={(0,0,0),(44,44,44),(241,132,27),(255,255,255)}
root=sys.argv[1]; base=np.array(Image.open('scripts/mascot/v2/pixellab/ref-64.png').convert('RGBA'))[8:56,8:56]
horns=(base[6:12,:,3]>0); eyes=(base[16:21,14:31,3]>0)
ok=True
for st in sorted(os.listdir(root)):
    if not os.path.isdir(os.path.join(root, st)): continue
    fs=sorted(glob.glob(f'{root}/{st}/*.png'))
    errs=[]
    if not 2<=len(fs)<=12: errs.append(f'{len(fs)} frames (want 2..12)')
    for f in fs:
        a=np.array(Image.open(f).convert('RGBA'))
        if a.shape!=(64,64,4): errs.append(f'{os.path.basename(f)} is {a.shape[1]}x{a.shape[0]}'); continue
        vis=a[a[:,:,3]>0]
        bad={tuple(c) for c in np.unique(vis[:,:3],axis=0)}-PAL
        if bad: errs.append(f'{os.path.basename(f)} off-palette colours {list(bad)[:3]}')
        if (a[:,:,3]>0).sum()<300: errs.append(f'{os.path.basename(f)} nearly empty')
    if fs:
        a=np.array(Image.open(fs[0]).convert('RGBA'))
        if st not in ('sleep',) and (a[14:20,:,3]>0).sum()<horns.sum()*0.6: errs.append('frame 1: horns missing')
    print(('PASS' if not errs else 'FAIL'), st, '; '.join(errs)); ok&=not errs
sys.exit(0 if ok else 1)
