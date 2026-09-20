"""Run with Blender --background --python this_file -- [state].
Native Blender image IO; pixel coordinates remain integral. Source base is immutable.
Frames are also packed into a Blender flipbook with unequal exposure times.
"""
import bpy
import json
import math
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent
BASE = OUT.parent / 'base-48.png'
K, D, O, W = (0, 0, 0, 255), (44, 44, 44, 255), (241, 132, 27, 255), (255, 255, 255, 255)
PAL = [K, D, O, W]
HOLDS = {'idle':[3,1,1,2,1,1,1,2], 'typing':[2,1,2,1],
         'thinking':[2,1,2,2], 'done':[2,1,2,2], 'error':[2,1,3],
         'sleep':[2,1,1,1,1,2], 'celebrate':[2,1,2,1],
         'idle-look-around':[2,1,3,1,3,2], 'idle-scratch':[2,1,1,1,1,3],
         'idle-yawn':[2,1,1,4,3], 'idle-sit':[2,1,3,1,1,2],
         'stretching':[2,1,1,4,3], 'wake-up':[3,1,1,3], 'excited':[2,1,2,1],
         'streaming':[2,1,2,1], 'thinking-deep':[2,1,1,3,1,2],
         'thinking-scratch-head':[2,1,2,1], 'planning':[2,1,1,4],
         'remembering':[2,1,2,1], 'deciding':[2,1,2,1]}
LOOPS = {'idle-look-around':True, 'idle-scratch':False, 'idle-yawn':False,
         'idle-sit':True, 'stretching':False, 'wake-up':False, 'excited':True,
         'streaming':True, 'thinking-deep':True, 'thinking-scratch-head':True,
         'planning':False, 'remembering':True, 'deciding':True}
# Group D timing and playback. The frame counts are those in the approved spec.
TOOL_STATES = {
    'searching':(4,5,True), 'searching-deep':(4,4,True), 'fetching-url':(4,4,True),
    'reading':(4,3,True), 'reading-pdf':(4,3,True), 'browsing':(4,5,True),
    'writing':(4,6,True), 'writing-code':(4,8,True), 'building':(4,6,True),
    'running-shell':(4,4,True), 'testing':(4,5,True), 'tests-green':(3,6,False),
    'committing':(4,4,False), 'calling':(4,6,False), 'calling-phone':(4,6,True),
    'receiving-message':(4,6,False), 'remembering-store':(4,4,False),
    'delegating':(4,5,False), 'handoff':(4,4,False), 'image-generating':(5,4,False),
    'speaking':(4,8,True), 'exporting':(4,5,False), 'sending-file':(4,8,False),
    'installing-skill':(4,5,False), 'downloading':(5,4,True), 'scheduling':(4,3,True)}
for state,(count,fps,loop) in TOOL_STATES.items():
    HOLDS[state] = ([2]+[1]*(count-2)+[2]) if loop else ([2]+[1]*(count-2)+[4])
    LOOPS[state] = loop

BLOCKED_STATES = {'asking':(4,4,True), 'waiting-approval':(4,3,True),
                  'waiting-long':(6,2,True), 'waiting-network':(3,4,True),
                  'rate-limited':(3,2,True), 'no-key':(3,3,True),
                  'offline':(3,2,True), 'locked':(3,3,False)}
HOLDS.update({'asking':[3,1,2,1], 'waiting-approval':[5,2,1,1],
              'waiting-long':[3,1,1,3,1,2], 'waiting-network':[2,1,2],
              'rate-limited':[3,1,2], 'no-key':[3,1,2], 'offline':[3,1,2], 'locked':[2,1,4]})
LOOPS.update({state:meta[2] for state,meta in BLOCKED_STATES.items()})

PROPS = {
    # Black is only ever an outline around white or orange: a free-standing black stroke
    # vanishes on the dark fur and the dark app surface (seen in group D, 20 Sep).
    'magnifier':['.KKK....','KWWWK...','KWWWK...','KWWWK...','.KKKKK..','...KOOK.','....KOOK','.....KK.'],
    'binoculars':['.KKK.K.KKK.','KWWWKOKWWWK','KWWWKOKWWWK','KWWWKKKWWWK','.KKK...KKK.'],
    'book':['KKKKKKKKKKK','KWWWWKWWWWK','KWOOWKWOOWK','KWWWWKWWWWK','KWOOWKWOOWK','KKKKKKKKKKK'],
    'pdf':['KKKKKK','KWWWWK','KWOOWK','KWWWWK','KWOOWK','KWWWWK','KWOOWK','KWWWWK','KWWWWK','KKKKKK'],
    'window':['KKKKKKKKK','KOOOOOOOK','KKKKKKKKK','KWWWWWWWK','KWWWWWWWK','KWWWWWWWK','KKKKKKKKK'],
    'paper':['KKKKKK','KWWWWK','KWWWWK','KWWWWK','KWWWWK','KKKKKK'],
    'pencil':['....KK.','...KOOK','..KOOK.','.KOOK..','KWWK...','.KK....'],
    'laptop':['KKKKKKKKKK','KWWWWWWWWK','KWOOWOOWWK','KWWWWWWWWK','KKKKKKKKKK','KOOOOOOOOK'],
    'terminal':['WWWWWWWWW','WKKKKKKKW','WKWKKKKKW','WKKWKKKKW','WKWKKKKKW','WKKKKKKKW','WWWWWWWWW'],
    'hammer':['KKKKK','KOOOK','KOOOK','KKKKK','.KWK.','.KWK.','.KWK.','.KKK.'],
    'tube':['KKKKK','.KWK.','.KWK.','.KWK.','.KOK.','.KOK.','.KOK.','..K..'],
    'check':['.....KK','....KOK','...KOK.','K.KOK..','KOOOK..','.KOK...','..K....'],
    'envelope':['KKKKKKK','KWKWKWK','KWWKWWK','KWWWWWK','KKKKKKK'],
    'phone':['.KKKK','KOOOK','KKOKK','.KOK.','.KOK.','.KOK.','KKOKK','KOOOK','.KKKK'],
    'chest':['KKKKKKKK','KOOOOOOK','KOOOKOOK','KOOOOOOK','KKKKKKKK'],
    'mini':['..KK..','.KWWK.','KWOOWK','KWOOWK','.KWWK.','KKWWKK','.K..K.','.K..K.'],
    'brush':['...KK.','..KOOK','..KOK.','.KOK..','KWWWK.','.KKK..'],
    'picture':['KKKKKKK','KWWWWWK','KWWWWWK','KWWWWWK','KWWWWWK','KWWWWWK','KKKKKKK'],
    'plane':['KKKKKKK','KWWWWWK','KWWWK..','KKKK...'],
    'puzzle':['..KKK..','..KWK..','KKKWKKK','KWWWWWK','KWWWWWK','KWWWWWK','KKKKKKK'],
    'clock':['..KKK..','.KWWWK.','KWWWWWK','KWWKWWK','KWWWWWK','.KWWWK.','..KKK..']}
image = bpy.data.images.load(str(BASE), check_existing=False)
raw = list(image.pixels)
# Blender stores rows bottom-up. Read byte colours from this non-float sRGB image.
base = {}
for y in range(48):
    for x in range(48):
        i = ((47-y)*48+x)*4
        c = tuple(round(v*255) for v in raw[i:i+4])
        if c[3]:
            assert c in PAL, (x, y, c)
            base[x, y] = c


def line(pixels, points, colour, radius=0):
    for (ax, ay), (bx, by) in zip(points, points[1:]):
        steps = max(abs(bx-ax), abs(by-ay), 1)
        for i in range(steps+1):
            x, y = round(ax+(bx-ax)*i/steps), round(ay+(by-ay)*i/steps)
            for dy in range(-radius, radius+1):
                for dx in range(-radius, radius+1):
                    pixels[x+dx, y+dy] = colour


DOUBLE_PROPS = False   # set per state in __main__; see GROUP_D
GROUP_D = {'searching','searching-deep','fetching-url','reading','reading-pdf','browsing','writing',
           'writing-code','building','running-shell','testing','tests-green','committing','calling',
           'calling-phone','receiving-message','remembering-store','delegating','handoff',
           'image-generating','speaking','exporting','sending-file','installing-skill','downloading',
           'scheduling'}

def prop_2px(rows):
    """Group E props use native 2px strokes, without scaling the mascot itself."""
    return [''.join(c*2 for c in row) for row in rows for _ in range(2)]


def face(head, kind):
    """'wide+open' applies both parts; each part is one of the kinds below."""
    for part in kind.split('+'):
        _face(head, part)


def _face(head, kind):
    if kind == 'normal':
        return
    if kind == 'dizzy':                              # X eyes, for error-crash
        for y in range(15, 22):
            for x in list(range(16, 21))+list(range(26, 31)):
                if head.get((x,y)) in (K, W): head[x,y] = O
        for left in (16, 26):
            line(head, [(left,16),(left+4,20)], K); line(head, [(left+4,16),(left,20)], K)
        return
    if kind == 'wink':                               # right eye closed, left eye kept
        for y in range(15, 22):
            for x in range(26, 31):
                if head.get((x,y)) in (K, W): head[x,y] = O
        line(head, [(26,18),(27,19),(29,19),(30,18)], K)
        return
    if kind == 'happy':                              # closed eyes curving up, and a smile
        for y in range(15, 22):
            for x in list(range(16, 21))+list(range(26, 31)):
                if head.get((x,y)) in (K, W): head[x,y] = O
        for left in (16, 26):
            line(head, [(left,19),(left+1,18),(left+3,18),(left+4,19)], K)
        _face(head, 'smile')
        return
    if kind == 'flat':                               # a straight mouth: neither smile nor sad
        for y in range(22,25):
            for x in range(19,26): head[x,y] = O
        line(head, [(20,23),(25,23)], K)
        return
    # Only erase actual eye and mouth pixels; the approved orange face stays intact.
    if kind in ('half', 'closed', 'sad', 'down', 'up', 'left', 'right', 'wide', 'closed-open', 'squint'):
        for y in range(15, 22):
            for x in list(range(16, 21))+list(range(26, 31)):
                if head.get((x,y)) in (K, W):
                    head[x,y] = O
        for left in (16, 26):
            if kind in ('closed', 'closed-open'):
                line(head, [(left,18),(left+1,19),(left+3,19),(left+4,18)], K)
            elif kind in ('half','sad'):
                for y in (18,19):
                    for x in range(left,left+5): head[x,y] = K
                head[left+3,18] = W
                head[left+1,19] = W
            elif kind == 'squint':
                line(head, [(left,17),(left,18),(left+4,18),(left+4,17)], K)
                line(head, [(left+1,19),(left+3,19)], K)
                head[left+3,18] = head[left+1,19] = W
            elif kind == 'wide':
                # Keep the approved 5x5 footprint and both highlights; square off the corners.
                for y in range(16,21):
                    for x in range(left,left+5):
                        if y == 16 and x in (left,left+4): continue
                        head[x,y] = K
                head[left+3,17] = head[left+1,19] = W
            else:
                dx, dy = {'up':(1,-1), 'down':(0,1), 'left':(-1,0), 'right':(1,0)}[kind]
                for (x,y), c in base.items():
                    if left <= x < left+5 and 16 <= y <= 20 and c in (K,W):
                        head[x+dx,y+dy] = c
    if kind in ('sad','smile','open','closed-open'):
        for y in range(22,26 if kind in ('open','closed-open') else 25):
            for x in range(19,26): head[x,y] = O
        if kind == 'sad':
            line(head, [(20,24),(21,23),(24,23),(25,24)], K)
            head[21,24] = head[24,24] = W
        elif kind == 'smile':
            line(head, [(19,22),(20,23),(21,24),(24,24),(25,23),(26,22)], K)
            head[21,23] = head[24,23] = W
        else:
            for y in range(22,26):
                for x in range(21,25): head[x,y] = K
            head[21,22] = head[24,22] = W


def frame(kind='normal', squash=0, head_y=0, head_x=0, jump=0, arms=None, z=None, star=False, prop=None, props=(), arms_in_front=False, over_eyes=False):
    head = {p:c for p,c in base.items() if p[1] <= 27}
    body = {p:c for p,c in base.items() if p[1] >= 28}
    face(head, kind)
    if arms:
        # Keep shoulder attachment; remove the hanging distal arms only.
        body = {(x,y):c for (x,y),c in body.items()
                if not (29 <= y <= 37 and ((arms[0] and x <= 11) or (arms[1] and x >= 35)))}
        # A black edge closes the exposed torso where a resting arm used to cover it.
        for side, path in enumerate(arms):
            if path:
                x = 12 if side == 0 else 34
                line(body, [(x,29),(x,35),(x+ (1 if side == 0 else -1),38)], K)
    # Inverse sample a one-pixel squash/widen to avoid forward-map holes.
    result = {}
    for y in range(28+min(0,squash),46):
        sy = min(45, max(28, round(28+(y-28-squash)*17/(17-squash))))
        for x in range(5,43):
            sx = round(23.5+(x-23.5)*32/(32+squash))
            if (sx,sy) in body: result[x,y-jump] = body[sx,sy]
    for (x,y),c in head.items(): result[x+head_x,y+head_y-jump] = c
    if arms:
        for path in arms:
            if path:
                shifted = [(x,y+squash-jump) for x,y in path]
                line(result, shifted, K, 2)
                line(result, shifted, D, 1)
    if z is not None:
        # zZZ: a small z by the head and two bigger ones climbing away (Darius, 20 Sep).
        small = prop_2px(['WWW','..W','.W.','W..','WWW'])
        big = prop_2px(['WWWW','...W','..W.','.W..','WWWW'])
        for rows,px,py in ((small,36,z),(big,42,z-8),(big,48,z-17)):
            for dy,row in enumerate(rows):
                for dx,c in enumerate(row):
                    if c == 'W' and -8 <= px+dx < 56 and -8 <= py+dy < 56: result[px+dx,py+dy] = W
    if star:
        result[7,8] = result[8,7] = W
    for rows,px,py in ([prop] if prop else []) + list(props):
        if DOUBLE_PROPS:
            # Group D was drawn with 1px props that did not read at 48px. Double them in
            # place, keeping the centre where the hand is (Darius, 20 Sep: 24x24 budget).
            w,h = len(rows[0]),len(rows)
            rows = prop_2px(rows); px -= w//2; py -= h//2
        assert 0 < len(rows) <= 24 and 0 < len(rows[0]) <= 24   # prop budget 24x24 (Darius, 20 Sep)
        assert all(len(row) == len(rows[0]) for row in rows)
        for dy,row in enumerate(rows):
            for dx,symbol in enumerate(row):
                if symbol == '.': continue
                x,y = px+dx,py+dy
                # Props never cover the eyes: a pixel that would is dropped, not drawn.
                if not over_eyes and 15+head_x <= x <= 32+head_x and 15+head_y-jump <= y <= 21+head_y-jump: continue
                if not (-8 <= x < 56 and -8 <= y < 56): continue
                result[x,y] = {'K':K,'W':W,'O':O}[symbol]
    if arms_in_front and arms:
        # The deny pose crosses the forearms in front of the lock, below the eyes.
        for path in arms:
            if path:
                shifted = [(x,y+squash-jump) for x,y in path]
                line(result, shifted, K, 2)
                line(result, shifted, D, 1)
    # Pose space stays 48x48 with the body at the origin; the canvas is 64x64 with the
    # body at (8,8), so props may spill 8px past the old edges on every side.
    assert all(-8 <= x < 56 and -8 <= y < 56 for x,y in result)
    return result


def save(pixels, path):
    im = bpy.data.images.new(path.stem, width=64, height=64, alpha=True)
    im.colorspace_settings.name = 'sRGB'
    rgba = [0.0]*(64*64*4)
    for (x,y),c in pixels.items():
        x,y = x+8,y+8                       # pose space -> canvas
        i = ((63-y)*64+x)*4
        rgba[i:i+4] = [v/255 for v in c]
    im.pixels.foreach_set(rgba)
    im.filepath_raw = str(path)
    im.file_format = 'PNG'
    im.save()
    bpy.data.images.remove(im)


# Groups B, F, G (Opus, 20 Sep): (frames, fps, loop). Holds follow the tool-state rule.
LAST_STATES = {
    'listening':(4,4,True), 'listening-headset':(6,5,True), 'reading-attachment':(4,4,True),
    'paste':(3,5,False), 'drag-drop':(3,6,False),
    'done-nod':(3,6,False), 'error-crash':(4,6,True), 'interrupted':(4,4,False),
    'confused':(4,4,True), 'retrying':(4,6,True), 'timeout':(3,3,False), 'partial':(3,4,False),
    'wave':(4,6,True), 'goodbye':(4,4,False), 'love':(4,5,True), 'cool':(3,3,False),
    'gaming':(4,8,True), 'surprised':(3,8,False), 'dreaming':(6,2,True)}
for state,(count,fps,loop) in LAST_STATES.items():
    HOLDS[state] = ([2]+[1]*(count-2)+[2]) if loop else ([2]+[1]*(count-2)+[4])
    LOOPS[state] = loop

def poses(state):
    # Group E uses the 64px canvas margin and 24px prop budget; pose coordinates stay 48px.
    if state in BLOCKED_STATES:
        question = prop_2px(['.KKKK.','KKWWKK','KKKKWK','..KWWK','..KWKK','..KKK.','..KWK.','..KKK.'])
        motion = [dict(squash=0,head_y=0),dict(squash=1,head_y=0),
                  dict(squash=0,head_y=1),dict(squash=0,head_y=0)]
    if state == 'asking':
        arms = [None,[(37,29),(42,23),(40,15)]]
        return 4,[frame('wide',head_x=(0,0,1,1)[i],arms=arms,
                        prop=(question,18,-8+(0,0,1,0)[i]),**motion[i]) for i in range(4)]
    if state == 'waiting-approval':
        arms = [[(10,29),(12,35),(18,31)],[(37,29),(35,35),(29,31)]]
        return 3,[frame('normal',arms=arms),frame('normal',squash=1,arms=arms),
                  frame('half',squash=1,head_y=1,arms=arms),frame('closed',head_y=1,arms=arms)]
    if state == 'waiting-long':
        glass = ['KKKKKKKKKK','KWWWWWWWWK','.KWWWWWWK.','..KWWWWK..','...KWWK...',
                 '...KWWK...','...KWWK...','...KWWK...','..KWWWWK..','.KWWWWWWK.',
                 'KWWWWWWWWK','KKKKKKKKKK']
        frames = []
        for amount,squash,hy in [(0,2,0),(1,3,0),(2,3,2),(3,2,2),(2,2,1),(0,2,0)]:
            rows = [list(r) for r in glass]
            for y in range(1,5):
                for x in range(10):
                    if rows[y][x] == 'W' and y > amount: rows[y][x] = 'O'
            for y in range(7,11):
                for x in range(10):
                    if rows[y][x] == 'W' and y >= 11-amount: rows[y][x] = 'O'
            if amount in (1,2): rows[5][4] = rows[6][4] = 'O'
            arms = [[(10,29),(12,35),(16,38)],[(37,29),(39,34),(36,36)]]
            frames.append(frame('down',squash=squash,head_y=hy,arms=arms,
                                prop=(prop_2px([''.join(r) for r in rows]),35,24+squash)))
        return 2,frames
    if state == 'waiting-network':
        frames = []
        for i,kind in enumerate(('left','up','right')):
            rows = [list('...........') for _ in range(3)]
            for dot in range(3):
                for y in range(3):
                    for x in range(3): rows[y][4*dot+x] = 'K'
                rows[1][4*dot+1] = 'W' if i==dot else 'K'
            frames.append(frame(kind,prop=(prop_2px([''.join(r) for r in rows]),13,-3),**motion[i]))
        return 4,frames
    if state == 'rate-limited':
        frames = []
        for i,(dx,dy) in enumerate(((0,-1),(1,0),(0,1))):
            clock = [list(r) for r in PROPS['clock']]
            clock[3][2] = 'K'
            for n in (1,2): clock[3+dy*n][3+dx*n] = 'O'
            frames.append(frame('half',prop=(prop_2px([''.join(r) for r in clock]),17,-8),**motion[i]))
        return 2,frames
    if state == 'no-key':
        key = prop_2px(['.KKKK.......','KWWWWK......','KWKKWKKKKKKK',
                       'KWKKWWWWWWWK','KWWWWKKKWKWK','.KKKK...KKKK'])
        hands = [[(10,29),(13,35),(18,35)],[(37,29),(39,38),(37,35)]]
        return 3,[frame('wide',arms=hands,props=[(key,16,30+motion[i]['squash']),
                        (question,18,-8)],**motion[i]) for i in range(3)]
    if state == 'offline':
        cloud = [list(r) for r in ['....KKKK....','..KKWWWWKK..','.KWWWWWWWWK.',
                                  'KWWWWWWWWWWK','KWWWWWWWWWWK','.KKKKKKKKKK.']]
        for x,y in ((3,4),(4,3),(5,3),(6,2),(7,2),(8,1)): cloud[y][x] = 'K'
        cloud = prop_2px([''.join(r) for r in cloud])
        arms = [[(10,30),(9,34),(10,37)],[(37,30),(38,34),(37,37)]]
        return 2,[frame('sad',arms=arms,prop=(cloud,12,-7),**motion[i]) for i in range(3)]
    if state == 'locked':
        lock = ['..KKKK..','.KK..KK.','.K....K.','.K....K.','KKKKKKKK',
                'KOOOOOOK','KOOOOOOK','KOOKKOOK','KOOKKOOK','KOOOOOOK','KKKKKKKK']
        arms = [[(10,29),(15,38),(29,34)],[(37,29),(32,38),(18,34)]]
        frames = []
        for i in range(3):
            rows = lock.copy()
            if i==0: rows[2:4] = ['.K......','.K......']
            frames.append(frame(arms=arms,arms_in_front=True,
                                prop=(prop_2px(rows),17,25+motion[i]['squash']),**motion[i]))
        return 3,frames
    # ---- Groups B, F, G (Opus). Pose space 48x48; props are 2px strokes, orange/white only.
    if state in LAST_STATES:
        breathe = [dict(squash=0,head_y=0),dict(squash=1,head_y=0),
                   dict(squash=1,head_y=1),dict(squash=0,head_y=1),dict(squash=0,head_y=0),dict(squash=0,head_y=0)]
        question = prop_2px(['.KKKK.','KKWWKK','KKKKWK','..KWWK','..KWKK','..KKK.','..KWK.','..KKK.'])
        bang = prop_2px(['KKK','KWK','KWK','KWK','KWK','KKK','KWK','KKK'])
        sparkle = prop_2px(['.K.','KWK','.K.'])
    if state == 'listening':
        arms = [None,[(37,29),(42,24),(36,17)]]                     # hand cupped at the ear
        return 4,[frame('wide',head_x=(0,0,1,1)[i],arms=arms,**breathe[i]) for i in range(4)]
    if state == 'listening-headset':
        band = prop_2px(['KKKKKKKKKKK','KOOOOOOOOOK','KKKKKKKKKKK'])          # 22x6 over the hood
        cup = prop_2px(['KKK','KOK','KOK','KOK','KKK'])                        # 6x10 at each ear
        return 6,[frame(props=[(band,13,3+m['head_y']),(cup,7,14+m['head_y']),(cup,35,14+m['head_y'])],**m)
                  for m in breathe]
    if state == 'reading-attachment':
        pic = prop_2px(PROPS['picture'])
        hands = [[(10,29),(12,36),(17,38)],[(37,29),(35,36),(30,38)]]
        return 4,[frame('down',arms=hands,prop=(pic,17,30+m['squash']),**m) for m in breathe[:4]]
    if state == 'paste':
        sheet = prop_2px(PROPS['pdf'][:8])
        point = [[(10,29),(12,36),(17,36)],[(37,29),(41,33),(31,33)]]
        return 3,[frame('down',arms=point,prop=(sheet,14,28+m['squash']),**m) for m in breathe[:3]]
    if state == 'drag-drop':
        up = [[(10,29),(5,24),(7,16)],[(37,29),(42,24),(40,16)]]
        return 3,[frame('wide+open',arms=up,squash=-1),frame('wide+open',arms=up,squash=0,head_y=1),
                  frame('wide+open',arms=up,squash=0)]
    if state == 'done-nod':
        return 3,[frame('smile'),frame('smile',head_y=2,squash=1),frame('smile')]
    if state == 'error-crash':
        orbit = [(14,2),(24,0),(34,2),(24,4)]
        return 4,[frame('dizzy',head_x=(-1,0,1,0)[i],props=[(sparkle,*orbit[i]),(sparkle,*orbit[(i+2)%4])],**breathe[i])
                  for i in range(4)]
    if state == 'interrupted':
        hand_y = (14,20,28,34)
        return 4,[frame(('wide','wide','half','half')[i],arms=[None,[(37,29),(42,22),(40,hand_y[i])]],
                        head_y=(0,0,1,1)[i],squash=(0,0,0,1)[i]) for i in range(4)]
    if state == 'confused':
        shrug = [[(10,29),(6,31),(8,26)],[(37,29),(41,31),(39,26)]]
        return 4,[frame('flat',arms=shrug,squash=-1,prop=(question,18,-8)),
                  frame('flat',arms=shrug,squash=-1,head_x=1,prop=(question,18,-7)),
                  frame('flat',arms=shrug,squash=0,head_x=1,prop=(question,18,-8)),
                  frame('flat',arms=shrug,squash=0,prop=(question,18,-7))]
    if state == 'retrying':
        arc = ['.KKKKK..','KWWWWWK.','KWKKKKWK','KWK..KWK','.K...KWK','.....KWK','..K.KWWK','..KWWWK.']
        def rot(rows): return [''.join(rows[len(rows)-1-x][y] for x in range(len(rows))) for y in range(len(rows[0]))]
        frames = []; rows = arc
        for i in range(4):
            frames.append(frame('squint',prop=(prop_2px(rows),16,-8),**breathe[i])); rows = rot(rows)
        return 4,frames
    if state == 'timeout':
        clock = [list(r) for r in PROPS['clock']]; clock[4][3] = clock[5][3] = 'O'   # hands hanging down
        clock = prop_2px([''.join(r) for r in clock])
        arm = [None,[(37,29),(43,20),(33,12)]]                              # hand to the forehead
        return 3,[frame('half',arms=arm,prop=(clock,36,26)),frame('half',arms=arm,squash=1,head_y=1,prop=(clock,36,27)),
                  frame('half',arms=arm,head_y=1,prop=(clock,36,27))]
    if state == 'partial':
        half = [list(r) for r in PROPS['check']]
        for y in range(4): half[y] = list('.......')                        # the top arm is missing
        half = prop_2px([''.join(r) for r in half])
        arms = [[(10,29),(8,27),(9,33)],None]                                 # one shoulder up
        return 3,[frame('flat',arms=arms,prop=(half,17,-6)),frame('flat',arms=arms,squash=1,prop=(half,17,-5)),
                  frame('flat',arms=arms,head_y=1,prop=(half,17,-6))]
    if state == 'wave':
        return 4,[frame('smile',arms=[None,[(37,29),(43,22),(40+(0,2,0,2)[i],14)]],**breathe[i]) for i in range(4)]
    if state == 'goodbye':
        return 4,[frame('smile',arms=[None,[(37,29),(43,22),(40,14)]]),
                  frame('smile',arms=[None,[(37,29),(43,22),(42,15)]],squash=1),
                  frame('half',arms=[None,[(37,29),(43,22),(40,15)]],squash=1,head_y=1),
                  frame('half',arms=[None,[(37,29),(42,26),(40,24)]],head_y=1)]
    if state == 'love':
        heart = prop_2px(['.KK.KK.','KOOKOOK','KOWOOOK','KOOOOOK','.KOOOK.','..KOK..','...K...'])
        return 4,[frame('happy',prop=(heart,17,(2,0,-2,-4)[i]),**breathe[i]) for i in range(4)]
    if state == 'cool':
        shades = ['KKKKKKK.K.KKKKKKK','KKWKKKKKKKKKWKKKK','KKKKKKK...KKKKKKK','.KKKKK.....KKKKK.']
        crossed = [[(10,29),(15,36),(28,33)],[(37,29),(32,36),(19,33)]]
        return 3,[frame('smile',arms=crossed,arms_in_front=True,prop=(shades,15,16),over_eyes=True),
                  frame('smile',arms=crossed,arms_in_front=True,prop=(shades,15,17),head_y=1,over_eyes=True),
                  frame('smile',arms=crossed,arms_in_front=True,prop=(shades,15,16),over_eyes=True)]
    if state == 'gaming':
        pad = prop_2px(['KKKKKKKKKK','KOOOOOOOOK','KOWOOOOWOK','KOOOOOOOOK','KKKKKKKKKK'])
        hands = [[[(10,29),(12,36),(17,38+i%2)],[(37,29),(35,36),(30,39-i%2)]] for i in range(4)]
        return 4,[frame('squint',arms=hands[i],prop=(pad,14,32+breathe[i]['squash']),**breathe[i]) for i in range(4)]
    if state == 'surprised':
        open_arms = [[(10,29),(5,31),(6,36)],[(37,29),(42,31),(41,36)]]
        return 3,[frame('wide+open',arms=open_arms,jump=1,prop=(bang,21,-8)),
                  frame('wide+open',arms=open_arms,prop=(bang,21,-7)),
                  frame('wide+open',arms=open_arms,prop=(bang,21,-8))]
    if state == 'dreaming':
        moon = prop_2px(['..KKK.','.KWWWK','KWWKKK','KWK...','KWWKKK','.KWWWK','..KKK.'])
        stars = [(10,0),(36,2)]
        return 2,[frame('closed',squash=(0,1,1,1,0,0)[i],head_y=(0,0,1,1,1,0)[i],
                        props=[(moon,18,-8)]+([(sparkle,*stars[i%2])] if i%2==0 or i==3 else []))
                  for i in range(6)]
    # Group D. The shared body cycle is compressed first; the head follows one frame later.
    motion = [dict(squash=0,head_y=0),dict(squash=1,head_y=0),
              dict(squash=1,head_y=1),dict(squash=0,head_y=1),dict(squash=0,head_y=0)]
    hold = [[(10,29),(13,35),(19,35)],[(37,29),(33,35),(29,35)]]
    if state == 'searching':
        frames = []
        for i,dx in enumerate((0,1,1,0)):
            arms = [[(10,29),(12,34),(16,35)],[(37,29),(42,28),(41+dx,21)]]
            frames.append(frame('right',arms=arms,prop=(PROPS['magnifier'],36+dx,15+motion[i]['squash']),**motion[i]))
        return 5,frames
    if state == 'reading':
        frames = []
        for i in range(4):
            book = PROPS['book'].copy()
            if i in (1,2):
                book[1:5] = ['KWWWWKKWWWK','KWOOWKKWOWK','KWWWWKKWWWK','KWOOWKKWWWK']   # page mid-turn
            frames.append(frame('down',arms=hold,prop=(book,19,32+motion[i]['squash']),**motion[i]))
        return 3,frames
    if state == 'browsing':
        frames = []
        for i,(cx,cy) in enumerate(((2,3),(3,3),(4,4),(3,4))):
            rows = [list(r) for r in PROPS['window']]
            for dy in (0,1):
                for dx in (0,1): rows[cy+dy][cx+dx] = 'O'
            frames.append(frame('down',arms=hold,prop=([''.join(r) for r in rows],20,31+motion[i]['squash']),**motion[i]))
        return 5,frames
    if state == 'writing':
        frames = []
        for i,dx in enumerate((0,1,0,1)):
            arms = [[(10,29),(13,34),(19,35)],[(37,29),(33,34),(26+dx,31)]]
            frames.append(frame('down',arms=arms,props=[(PROPS['paper'],19,32+motion[i]['squash']),
                                (PROPS['pencil'],23+dx,29+motion[i]['squash'])],**motion[i]))
        return 6,frames
    if state == 'building':
        frames = []
        for i,py in enumerate((20,18,25,20)):
            m = [dict(squash=0,head_y=0),dict(squash=-1,head_y=0),
                 dict(squash=1,head_y=-1),dict(squash=0,head_y=0)][i]
            arms = [None,[(37,29),(42,31),(40,py+7)]]
            props = [(PROPS['hammer'],38,py+m['squash'])]
            if i == 2: props.append((['.K.','KWK','.K.'],42,33))
            frames.append(frame('down',arms=arms,props=props,**m))
        return 6,frames
    if state == 'calling':
        frames = []
        for i,py in enumerate((23,22,21,None)):
            arms = [None,[(37,29),(42,28),(41,27 if py is None else py+4)]]
            props = [] if py is None else [(PROPS['envelope'],38,py)]
            frames.append(frame('smile',arms=arms,props=props,**motion[i]))
        return 6,frames
    if state == 'delegating':
        frames = []
        for i in range(4):
            rows = ['......']*(6-2*i)+PROPS['mini'][6-2*i:]
            arms = [None,[(37,29),(38,32),(40,31)]]
            frames.append(frame('right',arms=arms,prop=(rows,42,33),**motion[i]))
        return 5,frames
    if state == 'speaking':
        frames = []
        for i,count in enumerate((1,2,3,0)):
            rows = [list('..........') for _ in range(7)]
            for a in range(count):
                # Black contours surround the white arcs against any background.
                cx = 1+3*a
                for y in range(1,6):
                    x = cx+(1 if y in (2,3,4) else 0)
                    for dx,dy in ((-1,0),(1,0),(0,-1),(0,1)): rows[y+dy][x+dx] = 'K'
                for y in range(1,6): rows[y][cx+(1 if y in (2,3,4) else 0)] = 'W'
            frames.append(frame('open' if i%2==0 else 'normal',prop=([''.join(r) for r in rows],35,23),**motion[i]))
        return 8,frames
    if state == 'searching-deep':
        hands = [[(10,29),(15,32),(20,29)],[(37,29),(32,32),(27,29)]]
        return 4,[frame('down',head_x=(0,0,1,0)[i],arms=hands,
                        prop=(PROPS['binoculars'],19+(0,0,1,0)[i],26+motion[i]['squash']),**motion[i]) for i in range(4)]
    if state == 'fetching-url':
        frames = []
        for i,dx in enumerate((0,1,1,0)):
            rod = [list('..........') for _ in range(10)]
            for p in range(9): rod[9-p][1+p] = 'O'
            for y in range(2,8):
                rod[y][7],rod[y][8],rod[y][9] = 'K','W','K'
            rod[8][8] = 'K'
            arms = [None,[(37,29),(42,34),(38+dx,32)]]
            frames.append(frame('right',arms=arms,prop=([''.join(r) for r in rod],37+dx,23+motion[i]['squash']),**motion[i]))
        return 4,frames
    if state == 'reading-pdf':
        hands = [[(10,29),(14,35),(20,35)],[(37,29),(32,35),(27,35)]]
        return 3,[frame('down',arms=hands,prop=(PROPS['pdf'],21,29+motion[i]['squash']),
                        **(motion[i] | {'head_y':(0,0,1,2)[i]})) for i in range(4)]
    if state == 'writing-code':
        frames = []
        for i in range(4):
            laptop = [list(r) for r in PROPS['laptop']]
            laptop[3][2 if i%2==0 else 7] = 'O'
            hands = [[(10,29),(12,36),(18,38+i%2)],[(37,29),(35,36),(30,39-i%2)]]
            frames.append(frame('down',arms=hands,prop=([''.join(r) for r in laptop],19,35+motion[i]['squash']),**motion[i]))
        return 8,frames
    if state == 'running-shell':
        frames = []
        for i in range(4):
            terminal = PROPS['terminal'].copy()
            if i<2: terminal[4] = 'WKWKKWWKW'
            frames.append(frame('down',arms=hold,prop=(terminal,20,31+motion[i]['squash']),**motion[i]))
        return 4,frames
    if state == 'testing':
        frames = []
        for i in range(4):
            tube = [list(r) for r in PROPS['tube']]
            tube[(6,5,4,3)[i]][2] = 'W'
            arms = [None,[(37,29),(42,34),(40,31)]]
            frames.append(frame('down',arms=arms,prop=([''.join(r) for r in tube],38,25+motion[i]['squash']),**motion[i]))
        return 5,frames
    if state == 'tests-green':
        arm = [None,[(37,29),(42,19),(37,10)]]
        return 6,[frame('smile',arms=arm,prop=(PROPS['check'],20,0)),
                  frame('smile',jump=1,head_y=1,arms=arm,prop=(PROPS['check'],20,0)),
                  frame('smile',squash=1,arms=arm,prop=(PROPS['check'],20,0))]
    if state == 'committing':
        frames = []
        for i in range(4):
            graph = [list('.........') for _ in range(9)]
            for y in range(2,8): graph[y][2] = 'O'
            if i>=1:
                for x,y in ((3,5),(4,4),(5,3)): graph[y][x] = 'O'
            for n,(cx,cy) in enumerate(((2,7),(2,1),(6,2))):
                if n==2 and i<2: continue
                for y in range(cy-1,cy+2):
                    for x in range(cx-1,cx+2): graph[y][x] = 'K'
                graph[cy][cx] = 'O' if n==2 else 'W'
            frames.append(frame('down',arms=hold,prop=([''.join(r) for r in graph],20,30+motion[i]['squash']),**motion[i]))
        return 4,frames
    if state == 'calling-phone':
        arms = [None,[(37,29),(42,27),(39,22)]]
        return 6,[frame('open' if i%2==0 else 'normal',arms=arms,
                        prop=(PROPS['phone'],37,15+motion[i]['squash']),**motion[i]) for i in range(4)]
    if state == 'receiving-message':
        arms = [None,[(37,29),(42,27),(41,25)]]
        return 6,[frame('wide',arms=arms,prop=(PROPS['envelope'],38,py),**motion[i])
                  for i,py in enumerate((16,18,20,20))]
    if state == 'remembering-store':
        frames = []
        for i in range(4):
            chest = PROPS['chest'].copy()
            if i<3: chest[0:2] = ['K......K','KKKKKKKK']
            py = (34,35,36,36)[i]
            arms = [None,[(37,29),(39,33),(39,py)]]
            props = [(chest,35,37)]
            if i<3: props.append((['.K.','KWK','.K.'],38,py))
            frames.append(frame('down',arms=arms,props=props,**motion[i]))
        return 4,frames
    if state == 'handoff':
        note = ['KKKK','KWWK','KWWK','KKKK']
        frames = []
        for i,dx in enumerate((0,1,2,2)):
            arms = [None,[(37,29),(38,33),(39+dx,31)]]
            frames.append(frame('right',arms=arms,props=[(PROPS['mini'],42,33),(note,39+dx,30)],**motion[i]))
        return 4,frames
    if state == 'image-generating':
        frames = []
        for i in range(5):
            picture = [list(r) for r in PROPS['picture']]
            for x,y in ((2,4),(3,3),(4,2))[:min(i,3)]: picture[y][x] = 'O'
            dx = (0,1,0,1,1)[i]
            arms = [[(10,29),(12,34),(17,35)],[(37,29),(32,35),(24+dx,31)]]
            frames.append(frame('down',arms=arms,props=[([''.join(r) for r in picture],17,32+motion[i]['squash']),
                                (PROPS['brush'],21+dx,29+motion[i]['squash'])],**motion[i]))
        return 4,frames
    if state == 'exporting':
        frames = []
        for i,py in enumerate((28,30,32,None)):
            box = PROPS['chest'].copy()
            if i<3: box[0:2] = ['K......K','KKKKKKKK']
            props = [] if py is None else [(['KKKK','KWWK','KWWK','KKKK'],22,py)]
            props.append((box,20,35+motion[i]['squash']))
            frames.append(frame('down',arms=hold,props=props,**motion[i]))
        return 5,frames
    if state == 'sending-file':
        frames = []
        for i,position in enumerate(((36,25),(38,23),(40,21),None)):
            arm = [None,[(37,29),(40,31),(39,27)]]
            props = [] if position is None else [(PROPS['plane'],*position)]
            frames.append(frame('smile',arms=arm,props=props,**motion[i]))
        return 8,frames
    if state == 'installing-skill':
        frames = []
        for i,px in enumerate((33,28,23,23)):
            arm = [None,[(37,29),(36,37),(px+5,35)]]
            frames.append(frame('down',arms=arm,prop=(PROPS['puzzle'],px,31+motion[i]['squash']),**motion[i]))
        return 5,frames
    if state == 'downloading':
        arrow = ['..O..','..O..','..O..','O.O.O','.OOO.','..O..']
        frames = []
        for i,fill in enumerate((0,2,4,6,0)):
            bar = ['KKKKKKKK','K'+'O'*fill+'W'*(6-fill)+'K','K'+'O'*fill+'W'*(6-fill)+'K','KKKKKKKK']
            frames.append(frame('up',arms=hold,props=[(arrow,21,0),(bar,20,32+motion[i]['squash'])],**motion[i]))
        return 4,frames
    if state == 'scheduling':
        frames = []
        for i,(dx,dy) in enumerate(((0,-1),(1,0),(0,1),(-1,0))):
            clock = [list(r) for r in PROPS['clock']]
            clock[3][2] = 'K'
            for n in (1,2): clock[3+dy*n][3+dx*n] = 'O'
            arms = [None,[(37,29),(42,28),(41,24)]]
            frames.append(frame('right',arms=arms,prop=([''.join(r) for r in clock],38,18+motion[i]['squash']),**motion[i]))
        return 3,frames
    # Group C. Streaming already has an app-state equivalent (talking).
    if state == 'streaming':
        low = [[(10,29),(11,34),(16,35)],[(37,29),(41,28),(40,25)]]
        high = [[(10,29),(11,34),(16,35)],[(37,29),(41,27),(40,23)]]
        return 8, [frame('open',arms=low),frame('smile',squash=1,arms=high),
                   frame('open',squash=1,head_y=1,arms=low),frame('smile',head_y=1,arms=high)]
    if state == 'thinking-deep':
        chin = [None,[(37,29),(34,33),(29,25)]]
        frames = []
        for count,squash,hy in [(0,0,0),(1,1,0),(2,1,1),(3,0,1),(2,0,0),(0,0,0)]:
            dots = [list('.........') for _ in range(9)]
            for i in range(count):
                cx,cy = 1+3*i,7-3*i
                for y in range(cy-1,cy+2):
                    for x in range(cx-1,cx+2): dots[y][x] = 'K'
                dots[cy][cx] = 'W'
            frames.append(frame('up',squash=squash,head_y=hy,arms=chin,
                                prop=([''.join(row) for row in dots],37,0)))
        return 3,frames
    if state == 'thinking-scratch-head':
        a = [None,[(37,29),(41,23),(37,14)]]
        b = [None,[(37,29),(41,23),(37,15)]]
        return 4, [frame('squint',arms=a),frame('squint',squash=1,arms=b),
                   frame('squint',squash=1,head_x=2,arms=a),frame('squint',head_x=1,arms=b)]
    if state == 'planning':
        hands = [[(10,29),(12,35),(18,38)],[(37,29),(35,35),(29,38)]]
        frames = []
        for checks,squash,hy in [(0,0,0),(1,1,0),(2,1,1),(3,0,1)]:
            # 10x9 sheet: three lines with a 2x1 checkbox each; ticks fill in orange
            paper = [list(row) for row in ('KKKKKKKKKK','KWWWWWWWWK','KWWWWKKKWK','KWWWWWWWWK',
                                           'KWWWWKKKWK','KWWWWWWWWK','KWWWWKKKWK','KWWWWWWWWK','KKKKKKKKKK')]
            for i in range(checks):
                paper[2+2*i][2] = paper[2+2*i][3] = 'O'
            frames.append(frame('down',squash=squash,head_y=hy,arms=hands,
                                prop=([''.join(row) for row in paper],19,30+squash)))
        return 3,frames
    if state == 'remembering':
        small = ['..KKKKK...','.KWWWWWK..','KWWWOWWWK.','KWWWOWWWWK','.KKKKKKKK.']
        large = ['..KKKKK...','.KWWWWWKK.','KWWWOOWWWK','KWWWOOWWWK','KWWWWWWWWK','.KKKKKKKK.']
        return 4, [frame('up',prop=(small,18,2)),frame('up',squash=1,prop=(large,18,1)),
                   frame('up',squash=1,head_y=1,prop=(large,18,1)),frame('up',head_y=1,prop=(small,18,2))]
    if state == 'deciding':
        a = [[(10,29),(6,30),(5,26)],[(37,29),(41,31),(42,27)]]
        b = [[(10,29),(6,31),(5,27)],[(37,29),(41,30),(42,26)]]
        return 6, [frame('left',arms=a),frame('right',squash=1,arms=b),
                   frame('left',squash=1,head_x=1,arms=a),frame('right',head_x=-1,arms=b)]
    # Group A. Existing app states first; each cycle has head follow-through and held poses.
    if state == 'idle-look-around':
        return 4, [frame(),frame('left',squash=1),frame('left',squash=1,head_x=-1),
                   frame('right',head_x=-1),frame('right',head_x=1),frame()]
    if state == 'stretching':
        mid = [[(10,29),(7,27),(9,24)],[(37,29),(40,27),(38,24)]]
        high = [[(10,29),(6,23),(9,16)],[(37,29),(41,23),(38,16)]]
        return 5, [frame(),frame(squash=1,arms=mid),frame(squash=-2,arms=high),
                   frame('closed',squash=-2,head_y=-2,arms=high),frame()]
    if state == 'excited':
        low = [[(10,29),(7,30),(8,27)],[(37,29),(40,30),(39,27)]]
        high = [[(10,29),(6,26),(8,21)],[(37,29),(41,26),(39,21)]]
        # Two 2px hops per loop; the first landing compresses while the head settles late.
        return 8, [frame('smile',arms=low),frame('smile',jump=2,head_y=1,arms=high),
                   frame('smile',squash=1,head_y=-1,arms=low),frame('smile',jump=2,head_y=1,arms=high)]
    if state == 'idle-scratch':
        mid = [None,[(37,29),(41,26),(39,22)]]
        a = [None,[(37,29),(41,23),(36,14)]]
        b = [None,[(37,29),(41,23),(36,15)]]
        return 6, [frame(),frame(squash=1,arms=mid),frame(squash=1,head_y=1,arms=a),
                   frame(squash=1,head_y=1,arms=b),frame(squash=1,head_y=1,arms=a),frame()]
    if state == 'idle-yawn':
        mid = [None,[(37,29),(34,33),(31,29)]]
        mouth = [None,[(37,29),(34,32),(28,25)]]
        return 4, [frame(),frame('half',squash=1,arms=mid),frame('closed-open',squash=-1,arms=mouth),
                   frame('closed-open',squash=-1,head_y=-1,arms=mouth),frame()]
    if state == 'idle-sit':
        knees = [[(10,29),(11,35),(16,37)],[(37,29),(36,35),(31,37)]]
        return 4, [frame(squash=2,head_y=1,arms=knees),frame(squash=2,head_y=1,arms=knees),
                   frame(squash=2,head_y=2,arms=knees),frame('half',squash=2,head_y=2,arms=knees),
                   frame('closed',squash=2,head_y=2,arms=knees),frame(squash=2,head_y=1,arms=knees)]
    if state == 'wake-up':
        a = [[(10,29),(7,31),(8,27)],[(37,29),(40,31),(39,27)]]
        b = [[(10,29),(7,31),(9,28)],[(37,29),(40,31),(38,28)]]
        return 8, [frame('half',squash=1,head_y=1),frame('wide',jump=1,head_y=1,arms=a),
                   frame('wide',squash=1,arms=b),frame('wide')]
    if state == 'idle':
        return 6, [frame(), frame(), frame(squash=1), frame(squash=1,head_y=1),
                   frame(squash=1,head_y=1), frame('half',head_y=1), frame('closed'), frame()]
    if state == 'typing':
        # hands stop at the belly's edge (x 17 / 30) so the belly and its outline stay readable
        a = [[(10,29),(11,34),(16,35)],[(37,29),(36,34),(31,34)]]
        b = [[(10,29),(11,34),(16,34)],[(37,29),(36,34),(31,35)]]
        return 8, [frame('down',arms=a),frame('down',squash=1,arms=b),
                   frame('down',squash=1,head_y=1,arms=b),frame('down',head_y=1,arms=a)]
    if state == 'thinking':
        a = [None,[(37,29),(34,33),(29,25)]]
        return 4, [frame('up',arms=a),frame('up',squash=1,arms=a),
                   frame('up',squash=1,head_x=1,head_y=1,arms=a),frame('up',squash=1,head_x=1,head_y=1,arms=a)]
    if state == 'done':
        a = [None,[(37,29),(41,27),(40,22)]]
        return 6, [frame('smile',arms=a),frame('smile',squash=1,arms=a),
                   frame('smile',jump=1,head_y=1,arms=a),frame('smile',jump=1,head_y=1,arms=a)]
    if state == 'error':
        a = [[(10,30),(9,34),(10,37)],[(37,30),(38,34),(37,37)]]
        return 4, [frame('sad',arms=a),frame('sad',squash=1,arms=a),frame('sad',squash=1,head_y=1,arms=a)]
    if state == 'sleep':
        return 3, [frame('closed',squash=1,head_y=1,z=18),frame('closed',squash=2,head_y=1,z=16),
                   frame('closed',squash=2,head_y=2,z=14),frame('closed',squash=2,head_y=2,z=12),
                   frame('closed',squash=1,head_y=2,z=10),frame('closed',squash=1,head_y=1)]
    if state == 'celebrate':
        a = [[(10,29),(6,26),(7,21)],[(37,29),(41,26),(40,21)]]
        return 8, [frame('smile',arms=a),frame('smile',squash=1,arms=a),
                   frame('smile',jump=2,head_y=1,arms=a,star=True),frame('smile',jump=2,arms=a)]
    raise ValueError(state)


def blend_source(manifest):
    # Each state is an independent scene, with packed images and stepped visibility.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    first = bpy.context.scene
    for index,(state,meta) in enumerate(manifest.items()):
        # Optional timing metadata; fps remains the required converter fallback.
        holds = HOLDS[state]
        meta['durations_ms'] = [round(1000*n/meta['fps']) for n in holds]
        sc = first if index == 0 else bpy.data.scenes.new(state)
        sc.name = state
        sc.render.engine = 'BLENDER_WORKBENCH'
        sc.display.shading.light = 'FLAT'
        sc.display.shading.color_type = 'TEXTURE'
        sc.display.render_aa = 'OFF'
        sc.render.film_transparent = True
        sc.render.resolution_x = sc.render.resolution_y = 64
        sc.render.resolution_percentage = 100
        sc.render.fps = meta['fps']
        paths = sorted((OUT/state).glob('*.png'))
        exposures = [f for f,n in enumerate(holds,1) for _ in range(n)]
        sc.frame_start,sc.frame_end = 1,len(exposures)
        cam = bpy.data.cameras.new(state+' camera')
        cam.type,cam.ortho_scale = 'ORTHO',64
        co = bpy.data.objects.new(state+' camera',cam)
        sc.collection.objects.link(co)
        co.location = (0,0,50)
        sc.camera = co
        for f,path in enumerate(paths,1):
            im = bpy.data.images.load(str(path),check_existing=False)
            im.pack()
            mesh = bpy.data.meshes.new(state+path.stem)
            mesh.from_pydata([(-32,-32,0),(32,-32,0),(32,32,0),(-32,32,0)],[],[(0,1,2,3)])
            uv = mesh.uv_layers.new()
            for i,xy in enumerate([(0,0),(1,0),(1,1),(0,1)]): uv.data[i].uv = xy
            mat = bpy.data.materials.new(state+path.stem)
            mat.use_nodes = True
            tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
            tex.image,tex.interpolation = im,'Closest'
            bsdf = mat.node_tree.nodes.get('Principled BSDF')
            mat.node_tree.links.new(tex.outputs['Color'],bsdf.inputs['Base Color'])
            mat.node_tree.links.new(tex.outputs['Alpha'],bsdf.inputs['Alpha'])
            mesh.materials.append(mat)
            obj = bpy.data.objects.new(state+path.stem,mesh)
            sc.collection.objects.link(obj)
            for t,visible in enumerate(exposures,1):
                obj.hide_render = obj.hide_viewport = visible != f
                obj.keyframe_insert('hide_render',frame=t)
                obj.keyframe_insert('hide_viewport',frame=t)
        sc.frame_set(1)
    bpy.context.window.scene = first
    for area in bpy.context.screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_perspective = 'CAMERA'
            area.spaces.active.shading.color_type = 'TEXTURE'
            area.spaces.active.shading.light = 'FLAT'
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'astra.blend'))
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    manifest_path = OUT/'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    if args == ['source']:
        blend_source(manifest)
    else:
        assert len(args) == 1, 'Generate and validate one state at a time.'
        state = args[0]
        DOUBLE_PROPS = state in GROUP_D
        fps,frames = poses(state)
        dest = OUT/state
        dest.mkdir(parents=True,exist_ok=True)
        for f,pixels in enumerate(frames,1): save(pixels,dest/f'{f:03d}.png')
        assert len(HOLDS[state]) == len(frames)
        manifest[state] = {'fps':fps, 'durations_ms':[round(1000*n/fps) for n in HOLDS[state]]}
        if state in LOOPS: manifest[state]['loop'] = LOOPS[state]
        manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
        print('EXPORTED',state,len(frames),'frames',flush=True)
