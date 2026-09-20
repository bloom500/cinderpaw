"""body-48.txt + face-48.txt -> layer-{fur,skin,face}.png (48x48 RGBA)."""
from PIL import Image
g=open('scripts/mascot/v2/body-48.txt').read().split('\n')
f=open('scripts/mascot/v2/face-48.txt').read().split('\n')
pal={'k':(0,0,0,255),'d':(44,44,44,255),'o':(241,132,27,255),'w':(255,255,255,255)}
imgs={n:Image.new('RGBA',(48,48),(0,0,0,0)) for n in ('fur','skin','face')}
for y in range(48):
    for x in range(48):
        m=f[y][x]; ch=g[y][x]
        if m!='.': imgs['face'].putpixel((x,y),pal[m]); imgs['skin'].putpixel((x,y),pal['o'])
        elif ch in 'kd': imgs['fur'].putpixel((x,y),pal[ch])
        elif ch=='o': imgs['skin'].putpixel((x,y),pal['o'])
for n,im in imgs.items(): im.save(f'scripts/mascot/v2/layer-{n}.png')
