"""Trace the reference render on its real 20.5px grid (33x40 cells) -> body-48.txt,
then draw the face marks (eyes, highlights, smile, two teeth) -> face-48.txt."""
from PIL import Image, ImageDraw
import numpy as np
im=np.array(Image.open(r'C:\Users\Darius\Downloads\refine_a_raw.png').convert('RGB')).astype(int)
x0,y0,s,n,m=174,102,20.5,33,40
OX,OY=7,6
pal={'k':(0,0,0),'d':(44,44,44),'o':(241,132,27),'w':(255,255,255)}
def nearest(c):
    if c[1]>170 and c[0]<110: return '.'
    return min(pal, key=lambda ch: sum((a-b)**2 for a,b in zip(c,pal[ch])))
g=np.full((48,48),'.',dtype='<U1')
for j in range(m):
    for i in range(n):
        ya,yb=int(y0+j*s+5),int(y0+(j+1)*s-5); xa,xb=int(x0+i*s+5),int(x0+(i+1)*s-5)
        g[OY+j][OX+i]=nearest(np.median(im[ya:yb,xa:xb].reshape(-1,3),axis=0))
# hood interior specks: a 'k' with no transparent/orange neighbour is render noise
for y in range(OY+2,OY+7):
    for x in range(OX+3,OX+30):
        if g[y][x]=='k' and all(g[y+dy][x+dx] in 'kd' for dy in (-1,0,1) for dx in (-1,0,1)): g[y][x]='d'
# face interior: any dark pixel between two orange ones is noise
for y in range(OY+7,OY+20):
    for x in range(OX+7,OX+26):
        if g[y][x] in 'kd' and g[y][x-1]=='o':
            e=x
            while g[y][e] in 'kd': e+=1
            if g[y][e]=='o': g[y][x:e]='o'
# face interior: wipe the noisy eyes/mouth, we redraw them below
for y in range(OY+8,OY+20):
    for x in range(OX+7,OX+26):
        if g[y][x] in 'kw': g[y][x]='o'
marks=np.full((48,48),'.',dtype='<U1')
orun=[x for x in range(48) if g[21][x]=='o']; cx=(orun[0]+orun[-1])/2   # face centre on the mouth row
exl=int(round(cx-2-5.5)); exr=int(round(cx-2+5.5))                        # eye left edges, 11px apart
eye=Image.new('L',(48,48),0); d=ImageDraw.Draw(eye)
for ex in (exl,exr): d.ellipse([ex,16,ex+4,20],fill=1)       # 5x5 eyes
E=np.array(eye)>0; marks[E]='k'
for ex in (exl,exr): marks[17][ex+3]='w'; marks[19][ex+1]='w'   # big highlight top-right, small bottom-left
mx,my=int(round(cx)),23
for x in range(mx-2,mx+2): marks[my][x]='k'
for x,y,c in ((mx-3,my-1,'k'),(mx+2,my-1,'k'),(mx-2,my+1,'w'),(mx+1,my+1,'w')): marks[y][x]=c
g[marks!='.']=marks[marks!='.']
rows=[''.join(r) for r in g]
open('scripts/mascot/v2/body-48.txt','w').write('\n'.join(rows))
open('scripts/mascot/v2/face-48.txt','w').write('\n'.join(''.join(r) for r in marks))
bg={'.':(24,24,27),**pal}
out=Image.new('RGB',(48,48),(24,24,27))
for y,r in enumerate(rows):
    for x,ch in enumerate(r): out.putpixel((x,y),bg[ch])
out.resize((384,384),Image.NEAREST).save('scripts/mascot/v2/body-48-x8.png')
