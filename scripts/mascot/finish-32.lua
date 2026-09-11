-- finish-32.lua: corpul desenat O SINGURA DATA, 8 fete, 9 props, 23 taguri.
-- Citeste corpul din cinderpaw-32.aseprite (blana cadru 1), construieste
-- toate cadrele ca (acelasi corp + fata + prop) si salveaza REGRESIV.
-- Backup inainte, din linia de comanda. Rulare:
--   aseprite.exe -b --script scripts/mascot/finish-32.lua
local P = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-32.aseprite"
local PAL = {
  k = { 0x1a, 0x1a, 0x1a }, o = { 0xf2, 0x8c, 0x28 },
  h = { 0xff, 0xb1, 0x5e }, e = { 0x00, 0x00, 0x00 },
  w = { 0xff, 0xff, 0xff },
}
local HEX = {
  ["1a1a1a"] = "k", ["f28c28"] = "o", ["ffb15e"] = "h",
  ["000000"] = "e", ["ffffff"] = "w",
}
local function C(name)
  local c = PAL[name]
  return app.pixelColor.rgba(c[1], c[2], c[3], 255)
end

local src = app.open(P)
local bodyImg = nil
for _, layer in ipairs(src.layers) do
  if layer.name == "blana" then bodyImg = layer:cel(1).image end
end
assert(bodyImg ~= nil and bodyImg.width == 32 and bodyImg.height == 32, "corp lipsa")
local W, H = 32, 32
local body = {}
for yy = 0, H - 1 do
  body[yy] = {}
  for xx = 0, W - 1 do
    local v = bodyImg:getPixel(xx, yy)
    if app.pixelColor.rgbaA(v) < 128 then body[yy][xx] = "NONE"
    else
      local key = string.format("%02x%02x%02x",
        app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v))
      local k = HEX[key]
      assert(k ~= nil, "corp cu culoare straina: " .. key)
      body[yy][xx] = k
    end
  end
end
app.command.CloseFile()

-- Zonele fetei. In afara lor, niciun cadru nu atinge blana. NICIODATA.
local EYE_L = { x0 = 9, x1 = 14 }
local EYE_R = { x0 = 17, x1 = 23 }
local EYE_Y = { y0 = 7, y1 = 13 }
local MOUTH = { x0 = 13, x1 = 20, y0 = 12, y1 = 15 }
-- Fata e zona interzisa propsurilor: expresia nu se acopera.
local NO_PROP = { x0 = 9, x1 = 23, y0 = 7, y1 = 16 }

local function copyGrid(g)
  local c = {}
  for yy = 0, H - 1 do
    c[yy] = {}
    for xx = 0, W - 1 do c[yy][xx] = g[yy][xx] end
  end
  return c
end
local function eraseFace(g)
  for yy = EYE_Y.y0, EYE_Y.y1 do
    for xx = EYE_L.x0, EYE_L.x1 do
      if g[yy][xx] == "e" or g[yy][xx] == "w" then g[yy][xx] = "o" end
    end
    for xx = EYE_R.x0, EYE_R.x1 do
      if g[yy][xx] == "e" or g[yy][xx] == "w" then g[yy][xx] = "o" end
    end
  end
  for yy = MOUTH.y0, MOUTH.y1 do
    for xx = MOUTH.x0, MOUTH.x1 do
      if g[yy][xx] ~= "NONE" then g[yy][xx] = "o" end
    end
  end
end
-- Stampileaza doar pe portocaliu: geometria gresita pierde pixeli, nu strica.
local missed = 0
local function stamp(g, xx, yy, k)
  if xx < 0 or yy < 0 or xx >= W or yy >= H then missed = missed + 1 return end
  if g[yy][xx] == "o" then g[yy][xx] = k
  else missed = missed + 1 end
end
local function hline(g, x0, x1, y, k)
  for xx = x0, x1 do stamp(g, xx, y, k) end
end
local function block(g, x0, x1, y0, y1, k)
  for yy = y0, y1 do for xx = x0, x1 do stamp(g, xx, yy, k) end end
end

-- Cele 8 fete. 'neutral' e corpul asa cum e (fara stergere/stampila).
local FACES = {}
FACES.neutral = function(g) end
FACES.attentive = function(g)
  eraseFace(g)
  block(g, 10, 12, 8, 10, "e") stamp(g, 11, 7, "w")
  block(g, 18, 20, 8, 10, "e") stamp(g, 19, 7, "w")
  hline(g, 14, 18, 14, "e") stamp(g, 13, 13, "e") stamp(g, 19, 13, "e")
end
FACES.surprised = function(g)
  eraseFace(g)
  block(g, 9, 13, 8, 12, "e") stamp(g, 10, 7, "w")
  block(g, 17, 22, 8, 12, "e") stamp(g, 18, 7, "w")
  block(g, 15, 16, 13, 14, "e")
end
FACES.pleased = function(g)
  eraseFace(g)
  hline(g, 10, 12, 10, "e") stamp(g, 9, 9, "e") stamp(g, 13, 9, "e")
  hline(g, 18, 20, 10, "e") stamp(g, 17, 9, "e") stamp(g, 21, 9, "e")
  hline(g, 14, 18, 14, "e") stamp(g, 13, 13, "e") stamp(g, 19, 13, "e")
end
FACES.tired = function(g)
  eraseFace(g)
  hline(g, 10, 12, 9, "e") block(g, 10, 12, 10, 11, "e")
  hline(g, 18, 20, 9, "e") block(g, 18, 20, 10, 11, "e")
  hline(g, 15, 17, 14, "e")
end
FACES.focused = function(g)
  eraseFace(g)
  block(g, 11, 13, 10, 12, "e") stamp(g, 12, 9, "e")
  block(g, 17, 19, 10, 12, "e") stamp(g, 18, 9, "e")
  hline(g, 14, 18, 14, "e")
end
FACES.concerned = function(g)
  eraseFace(g)
  block(g, 9, 11, 8, 10, "e") stamp(g, 10, 7, "e")
  block(g, 20, 22, 8, 10, "e") stamp(g, 21, 7, "e")
  hline(g, 14, 18, 14, "e") stamp(g, 14, 15, "e") stamp(g, 18, 15, "e")
end
FACES.asleep = function(g)
  eraseFace(g)
  hline(g, 10, 12, 10, "e")
  hline(g, 18, 20, 10, "e")
  hline(g, 15, 16, 14, "e")
end

-- Cele 9 props. Coordonate absolute, pe accesorii. Niciun pixel in NO_PROP.
local PROPS = {}
local function propPixel(px, xx, yy, k)
  assert(not (xx >= NO_PROP.x0 and xx <= NO_PROP.x1
    and yy >= NO_PROP.y0 and yy <= NO_PROP.y1), "prop peste fata!")
  px[#px + 1] = {xx, yy, k}
end
PROPS.magnifier = function(px)
  local ring = { {26,4},{27,3},{28,3},{29,4},{29,5},{28,6},{27,6},{26,5} }
  for i = 1, #ring do propPixel(px, ring[i][1], ring[i][2], "h") end
  propPixel(px, 27, 4, "w")
  propPixel(px, 29, 7, "h") propPixel(px, 30, 8, "h") propPixel(px, 30, 9, "h")
end
PROPS.wrench = function(px)
  for yy = 21, 26 do propPixel(px, 3, yy, "h") end
  propPixel(px, 2, 19, "h") propPixel(px, 2, 20, "h")
  propPixel(px, 4, 19, "h") propPixel(px, 4, 20, "h")
  propPixel(px, 3, 27, "h")
end
PROPS.bubbleSmall = function(px)
  propPixel(px, 4, 6, "w") propPixel(px, 6, 4, "w") propPixel(px, 8, 2, "w")
end
PROPS.bubbleBig = function(px)
  PROPS.bubbleSmall(px)
  local ring = { {3,2},{4,1},{5,1},{6,2},{6,3},{5,4},{4,4},{3,3} }
  for i = 1, #ring do propPixel(px, ring[i][1], ring[i][2], "w") end
  propPixel(px, 4, 2, "w") propPixel(px, 5, 3, "w")
end
PROPS.excl = function(px)
  for yy = 8, 11 do propPixel(px, 28, yy, "w") end
  propPixel(px, 28, 13, "w")
end
PROPS.exclBig = function(px)
  for yy = 7, 11 do propPixel(px, 28, yy, "w") end
  propPixel(px, 28, 13, "w")
end
PROPS.checkSmall = function(px)
  for _, p in ipairs({ {23,25},{24,26},{25,25},{26,23} }) do
    propPixel(px, p[1], p[2], "h")
  end
end
PROPS.checkBig = function(px)
  PROPS.checkSmall(px)
  propPixel(px, 27, 21, "h") propPixel(px, 28, 19, "h")
end
PROPS.book = function(px)
  for xx = 1, 6 do propPixel(px, xx, 22, "e") propPixel(px, xx, 27, "e") end
  for yy = 23, 26 do propPixel(px, 1, yy, "e") propPixel(px, 6, yy, "e") end
  for yy = 23, 26 do for xx = 2, 5 do propPixel(px, xx, yy, "o") end end
  for yy = 23, 26 do propPixel(px, 3, yy, "e") end
end
PROPS.mug = function(px)
  for yy = 23, 26 do for xx = 26, 29 do propPixel(px, xx, yy, "o") end end
  for xx = 26, 29 do propPixel(px, xx, 23, "e") end
  for yy = 23, 26 do propPixel(px, 30, yy, "o") end
end
PROPS.bulb = function(px)
  local ring = { {14,1},{15,0},{16,0},{17,1},{17,3},{16,4},{15,4},{14,3} }
  for i = 1, #ring do propPixel(px, ring[i][1], ring[i][2], "h") end
  propPixel(px, 15, 1, "w") propPixel(px, 16, 2, "w")
  propPixel(px, 15, 5, "e") propPixel(px, 16, 5, "e")
end
PROPS.zzz = function(px)
  local function z(x, y)
    propPixel(px, x, y, "w") propPixel(px, x + 1, y, "w")
    propPixel(px, x + 1, y + 1, "w")
    propPixel(px, x, y + 2, "w") propPixel(px, x + 1, y + 2, "w")
  end
  z(24, 11) z(26, 8) z(28, 5)
end
PROPS.zzzUp = function(px)
  local function z(x, y)
    propPixel(px, x, y, "w") propPixel(px, x + 1, y, "w")
    propPixel(px, x + 1, y + 1, "w")
    propPixel(px, x, y + 2, "w") propPixel(px, x + 1, y + 2, "w")
  end
  z(24, 10) z(26, 7) z(28, 4)
end

-- Starile: (fata, prop). Propul nil = fara accesorii.
local STATES = {
  idle = { face = "neutral" },
  typing = { face = "attentive" },
  thinking = { face = "focused", props = { "bubbleSmall", "bubbleBig" } },
  calling = { face = "attentive", props = { "excl", "exclBig" } },
  done = { face = "pleased", props = { "checkSmall", "checkBig" } },
  running = { face = "surprised" },
  wave = { face = "pleased" },
  sleep = { face = "asleep", props = { "zzz", "zzzUp" } },
  surprised = { face = "surprised", props = { "excl" } },
  curious = { face = "attentive", props = { "magnifier" } },
  celebrate = { face = "pleased", props = { "bulb", "bulbExcl" } },
  reading = { face = "focused", props = { "book" } },
  searching = { face = "focused", props = { "magnifier" } },
  building = { face = "focused", props = { "wrench" } },
  writing = { face = "neutral", props = { "mug" } },
  stretching = { face = "tired" },
  gaming = { face = "pleased", props = { "mug" } },
  love = { face = "pleased", props = { "bubbleBig" } },
  cool = { face = "attentive", props = { "bulb" } },
  error = { face = "concerned", props = { "excl", "none" } },
  excited = { face = "surprised", props = { "bulb" } },
  spawning = { face = "surprised", props = { "checkSmall" } },
  meditating = { face = "asleep" },
}
-- Prop compus: bulb + excl, pentru celebrate cadrul 2.
PROPS.bulbExcl = function(px)
  PROPS.bulb(px)
  PROPS.excl(px)
end

local ORDER = { "idle", "typing", "thinking", "calling", "done", "running",
  "wave", "sleep", "surprised", "curious", "celebrate", "reading",
  "searching", "building", "writing", "stretching", "gaming", "love",
  "cool", "error", "excited", "spawning", "meditating" }

-- Corpul nemiscat: masca lui e silueta, la fel pe toate cadrele.
local mask = Image(W, H)
for yy = 0, H - 1 do
  for xx = 0, W - 1 do
    if body[yy][xx] ~= "NONE" then mask:drawPixel(xx, yy, C("e")) end
  end
end

local spr = Sprite(W, H, ColorMode.RGB)
local lSil = spr:newLayer() lSil.name = "silueta"
local lFur = spr:newLayer() lFur.name = "blana"
local lShd = spr:newLayer() lShd.name = "umbre"
local lAcc = spr:newLayer() lAcc.name = "accesorii"

local function imgOf(g)
  local im = Image(W, H)
  for yy = 0, H - 1 do
    for xx = 0, W - 1 do
      if g[yy][xx] ~= "NONE" then im:drawPixel(xx, yy, C(g[yy][xx])) end
    end
  end
  return im
end
local function propImg(names)
  local im = Image(W, H)
  if names ~= nil then
    for i = 1, #names do
      local px = {}
      PROPS[names[i]](px)
      for j = 1, #px do
        im:drawPixel(px[j][1], px[j][2], C(px[j][3]))
      end
    end
  end
  return im
end

-- Cadrele idle 1-4 raman exact cele desenate (neutral, blink, lookL, lookR).
local idleOld = {}
do
  local s2 = app.open(P)
  local bl = nil
  for _, layer in ipairs(s2.layers) do
    if layer.name == "blana" then bl = layer end
  end
  for f = 1, 4 do
    local g = {}
    local img = bl:cel(f).image
    for yy = 0, H - 1 do
      g[yy] = {}
      for xx = 0, W - 1 do
        local v = img:getPixel(xx, yy)
        if app.pixelColor.rgbaA(v) < 128 then g[yy][xx] = "NONE"
        else
          local key = string.format("%02x%02x%02x",
            app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v))
          g[yy][xx] = HEX[key]
        end
      end
    end
    idleOld[f] = g
  end
  app.command.CloseFile()
end

-- Compune toate cadrele. Verifica pe drum: blana difera de corp DOAR in
-- zonele fetei; paleta are exact 5 culori + transparent.
local FACE_OK = {}
for yy = EYE_Y.y0, EYE_Y.y1 do
  for xx = EYE_L.x0, EYE_L.x1 do FACE_OK[yy * W + xx] = true end
  for xx = EYE_R.x0, EYE_R.x1 do FACE_OK[yy * W + xx] = true end
end
for yy = MOUTH.y0, MOUTH.y1 do
  for xx = MOUTH.x0, MOUTH.x1 do FACE_OK[yy * W + xx] = true end
end
local usedColors = {}
local function note(g)
  for yy = 0, H - 1 do
    for xx = 0, W - 1 do
      if g[yy][xx] ~= "NONE" then usedColors[g[yy][xx]] = true end
    end
  end
end
note(body)
local frames = {}
local function addFrame(faceName, propNames)
  local g = copyGrid(body)
  if faceName ~= "neutral" then FACES[faceName](g) end
  for yy = 0, H - 1 do
    for xx = 0, W - 1 do
      if g[yy][xx] ~= body[yy][xx] and not FACE_OK[yy * W + xx] then
        error("corp atins in afara fetei la " .. xx .. "," .. yy)
      end
    end
  end
  note(g)
  local acc = Image(W, H)
  if propNames ~= nil then
    local px = {}
    for i = 1, #propNames do
      if propNames[i] ~= "none" then PROPS[propNames[i]](px) end
    end
    for j = 1, #px do
      acc:drawPixel(px[j][1], px[j][2], C(px[j][3]))
      usedColors[px[j][3]] = true
    end
  end
  frames[#frames + 1] = { fur = imgOf(g), acc = acc }
end

-- idle pastreaza cadrele vechi; restul se compun.
local tagRanges = {}
local function addTag(name, list)
  local from = #frames + 1
  for i = 1, #list do
    if name == "idle" then
      local g = idleOld[list[i]]
      note(g)
      frames[#frames + 1] = { fur = imgOf(g), acc = Image(W, H) }
    else
      addFrame(list[i][1], list[i][2])
    end
  end
  tagRanges[name] = { from, #frames }
end
addTag("idle", { 1, 2, 3, 4 })
for i = 2, #ORDER do
  local st = STATES[ORDER[i]]
  if st.props ~= nil then
    local list = {}
    for j = 1, #st.props do list[j] = { st.face, { st.props[j] } } end
    addTag(ORDER[i], list)
  else
    addTag(ORDER[i], { { st.face, nil } })
  end
end
print("cadre: " .. #frames .. ", ratari stampila: " .. missed)

while #spr.frames < #frames do spr:newEmptyFrame() end
for f = 1, #frames do
  spr:newCel(lSil, f, mask, Point(0, 0))
  spr:newCel(lFur, f, frames[f].fur, Point(0, 0))
  spr:newCel(lAcc, f, frames[f].acc, Point(0, 0))
end
for i = 1, #ORDER do
  local r = tagRanges[ORDER[i]]
  local t = spr:newTag(r[1], r[2])
  t.name = ORDER[i]
end
for f = 1, #frames do spr.frames[f].duration = 0.160 end
spr:saveAs(P)
print("OK salvat: " .. P)

-- Export pentru aplicatie: PNG pe cadru (doar blana+accesorii; silueta e
-- strat de verificare si nu se livreaza, ca golurile sa ramana transparente
-- reale) + frames.ts catalog. Directorul states/ exista deja (facut din CLI).
local APPDIR = "D:/Cinderpaw Agent/frontend-react/src/components/chat/mascot/states/"
local function compFrame(f)
  local im = Image(W, H)
  for _, lname in ipairs({ "blana", "accesorii" }) do
    local layer = nil
    for _, l in ipairs(spr.layers) do
      if l.name == lname then layer = l end
    end
    local cel = layer:cel(f)
    if cel ~= nil then
      local src = cel.image
      for yy = 0, H - 1 do
        for xx = 0, W - 1 do
          local v = src:getPixel(xx, yy)
          if app.pixelColor.rgbaA(v) >= 128 then
            im:drawPixel(xx, yy, v)
          end
        end
      end
    end
  end
  return im
end
local imports = {}
local groups = {}
for i = 1, #ORDER do
  local r = tagRanges[ORDER[i]]
  groups[i] = {}
  for f = r[1], r[2] do
    local stem = ORDER[i] .. "-" .. (f - r[1] + 1)
    compFrame(f):saveAs(APPDIR .. stem .. ".png")
    imports[#imports + 1] = "import f_" .. ORDER[i] .. "_" .. (f - r[1] + 1)
      .. " from './states/" .. stem .. ".png';"
    groups[i][#groups[i] + 1] = stem
  end
end
print("png exportate: " .. #imports)
local out = io.open("D:/Cinderpaw Agent/frontend-react/src/components/chat/mascot/frames.ts", "w")
local function w(s) out:write(s .. "\n") end
w("// Generated by scripts/mascot/finish-32.lua from cinderpaw-32.aseprite.")
w("// Do not edit. Our creature: one body, 8 faces, 9 props, 23 states.")
w("// 32px art, shown at 64 (DISPLAY in CinderpawMascot).")
w("")
for i = 1, #imports do w(imports[i]) end
w("")
w("export type MascotState =")
w("  | 'idle' | 'typing' | 'thinking' | 'calling' | 'done' | 'running'")
w("  | 'wave' | 'sleep' | 'surprised' | 'curious' | 'celebrate'")
w("  | 'reading' | 'searching' | 'building' | 'writing'")
w("  | 'stretching' | 'gaming' | 'love' | 'cool' | 'error' | 'excited'")
w("  | 'spawning' | 'meditating';")
w("")
w("export const FRAME_W = 32;")
w("export const FRAME_H = 32;")
w("")
w("const ART: Record<string, string> = {")
for i = 1, #ORDER do
  local r = tagRanges[ORDER[i]]
  for f = r[1], r[2] do
    local stem = ORDER[i] .. "-" .. (f - r[1] + 1)
    w("  '" .. stem .. "': f_" .. ORDER[i] .. "_" .. (f - r[1] + 1) .. ",")
  end
end
w("};")
w("")
w("export const GROUPS: Record<MascotState, string[]> = {")
for i = 1, #ORDER do
  local parts = {}
  for j = 1, #groups[i] do parts[#parts + 1] = "'" .. groups[i][j] .. "'" end
  w("  " .. ORDER[i] .. ": [" .. table.concat(parts, ", ") .. "],")
end
w("};")
w("")
w("// Frame cycling: multi-frame states animate, single-frame states hold.")
w("// Pure function of (state, tick): same tick, same frame, always.")
w("export function frameFor(state: MascotState, tick: number): string {")
w("  const group = GROUPS[state] ?? GROUPS.idle;")
w("  return group[((tick % group.length) + group.length) % group.length];")
w("}")
w("export function artUrl(name: string): string {")
w("  const url = ART[name];")
w("  if (!url) throw new Error('unknown state frame: ' + name);")
w("  return url;")
w("}")
out:close()
print("frames.ts scris")

-- Raportul final: 23 taguri, paleta, cadre pe tag.
local names = {}
for _, t in ipairs(spr.tags) do
  names[#names + 1] = t.name .. "=" .. t.fromFrame.frameNumber .. "-" .. t.toFrame.frameNumber
end
print("taguri: " .. table.concat(names, " "))
local cols = {}
for k, _ in pairs(usedColors) do cols[#cols + 1] = k end
table.sort(cols)
print("paleta: " .. table.concat(cols, ","))
