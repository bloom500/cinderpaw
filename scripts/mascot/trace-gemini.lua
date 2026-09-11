-- trace-gemini.lua: baza unica 96x96, 1 la 1 dupa originalul curat.
-- Sursa: scripts/mascot/gemini-96.png (96x96, 6 culori, recuperat bit-perfect
-- din preview-ul x6: 0 blocuri neuniforme din 9216). Nicio reesantionare,
-- nicio netezire, nicio geometrie inventata: fiecare pixel nativ ajunge pe
-- layerul lui cu culoarea lui. Fidelitate, nu interpretare.
-- Iesire: scripts/mascot/cinderpaw-96.aseprite, 4 layere, un frame, tag idle.
-- Rulare: aseprite.exe -b --script scripts/mascot/trace-gemini.lua
local REF = "D:/Cinderpaw Agent/scripts/mascot/gemini-96.png"
local OUT = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-96.aseprite"
local N = 96

-- Culorile native masurate, singurele care au voie in blana.
local BG = { 0x3a, 0x3a, 0x3a }
local MAP = {
  ["1a1a1a"] = "k", -- blana
  ["f28c28"] = "o", -- fata si burta
  ["ffb15e"] = "h", -- coarne
  ["000000"] = "e", -- ochi, gura, labe
  ["ffffff"] = "w", -- sparkle
}
local PAL = {
  k = { 0x1a, 0x1a, 0x1a }, o = { 0xf2, 0x8c, 0x28 },
  h = { 0xff, 0xb1, 0x5e }, e = { 0x00, 0x00, 0x00 },
  w = { 0xff, 0xff, 0xff },
}
local function C(name)
  local c = PAL[name]
  return app.pixelColor.rgba(c[1], c[2], c[3], 255)
end

local src = Image{ fromFile = REF }
assert(src.width == N and src.height == N, "sursa nu e 96x96")

local cls = {}
local strays = 0
for yy = 0, N - 1 do
  cls[yy] = {}
  for xx = 0, N - 1 do
    local v = src:getPixel(xx, yy)
    local key = string.format("%02x%02x%02x",
      app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v))
    if key == "3a3a3a" then
      cls[yy][xx] = "NONE"
    else
      local k = MAP[key]
      if k == nil then
        strays = strays + 1
        if strays <= 10 then print("pixel strain: " .. key .. " la " .. xx .. "," .. yy) end
        k = "NONE"
      end
      cls[yy][xx] = k
    end
  end
end
print("pixeli straini: " .. strays)
assert(strays == 0, "sursa contine culori in afara celor 6 native")

-- Gauri inchise: fundal prins in blana (30 de buzunare, cel mare de 314
-- intre coarne). Transparenta acolo ar arata ce e in spate, necontrolat,
-- pe ambele teme. Regula: umple cu blana; ce atinge portocaliul primeste
-- muchie neagra, ca sa ramana granita fetei/burtii clara.
local outside = {}
for yy = 0, N - 1 do outside[yy] = {} end
local Q, qh = {}, 1
local function pushO(x, y)
  if x < 0 or y < 0 or x >= N or y >= N then return end
  if cls[y][x] ~= "NONE" or outside[y][x] then return end
  outside[y][x] = true
  Q[#Q + 1] = { x, y }
end
for x = 0, N - 1 do pushO(x, 0) pushO(x, N - 1) end
for y = 0, N - 1 do pushO(0, y) pushO(N - 1, y) end
while qh <= #Q do
  local c = Q[qh]
  qh = qh + 1
  pushO(c[1] + 1, c[2]) pushO(c[1] - 1, c[2])
  pushO(c[1], c[2] + 1) pushO(c[1], c[2] - 1)
end
local D4 = { {1,0}, {-1,0}, {0,1}, {0,-1} }
local filledK, filledE = 0, 0
for pass = 1, 20 do
  local changed = false
  for yy = 0, N - 1 do
    for xx = 0, N - 1 do
      if cls[yy][xx] == "NONE" and not outside[yy][xx] then
        local touchO, touchD = false, false
        for i = 1, 4 do
          local nx, ny = xx + D4[i][1], yy + D4[i][2]
          if nx >= 0 and ny >= 0 and nx < N and ny < N then
            local nb = cls[ny][nx]
            if nb ~= "NONE" and outside[ny][nx] ~= true then
              touchD = true
              if nb == "o" then touchO = true end
            elseif nb ~= "NONE" then
              touchD = true -- vecin umplut deja in trecerea asta
            end
          end
        end
        if touchD then
          if touchO then cls[yy][xx] = "e" filledE = filledE + 1
          else cls[yy][xx] = "k" filledK = filledK + 1 end
          changed = true
        end
      end
    end
  end
  if not changed then break end
end
print(string.format("gauri umplute: blana=%d muchie=%d", filledK, filledE))

-- Ochi simetrici: dreptul e curat, stangul avea sparkle portocaliu in sursa.
-- Oglindire dreapta -> stanga in jurul lui x=47, pe dreptunghiul pupilei.
for yy = 24, 37 do
  for xx = 28, 40 do cls[yy][xx] = cls[yy][94 - xx] end
end
print("ochi: oglindit dreapta -> stanga")

-- Labe si maini pline: despicaturi de 1-2 px intre degete (sursele arata
-- transparent prin ele). Umple doar siruri scurte flancate de blana, in
-- zone explicite, ca sa nu atinga lateralele brat-corp sau silueta.
local ZONES = { {26,88,43,93}, {53,88,70,93}, {9,66,18,74}, {78,66,87,74} }
local slitK = 0
for zi = 1, #ZONES do
  local z = ZONES[zi]
  for yy = z[2], z[4] do
    local xx = z[1]
    while xx <= z[3] do
      if cls[yy][xx] == "NONE" and xx > 0 and cls[yy][xx - 1] ~= "NONE" then
        local xe = xx + 1
        while xe <= z[3] and cls[yy][xe] == "NONE" do xe = xe + 1 end
        if xe <= N - 1 and cls[yy][xe] ~= "NONE" and xe - xx <= 2 then
          for x = xx, xe - 1 do cls[yy][x] = "k" slitK = slitK + 1 end
        end
        xx = xe
      else
        xx = xx + 1
      end
    end
  end
end
print("despicaturi umplute: " .. slitK)

local minX, minY, maxX, maxY, massN = N, N, -1, -1, 0
local hist = {}
for yy = 0, N - 1 do
  for xx = 0, N - 1 do
    local k = cls[yy][xx]
    hist[k] = (hist[k] or 0) + 1
    if k ~= "NONE" then
      if xx < minX then minX = xx end
      if xx > maxX then maxX = xx end
      if yy < minY then minY = yy end
      if yy > maxY then maxY = yy end
      massN = massN + 1
    end
  end
end
for k, v in pairs(hist) do print(string.format("zona %s: %d", k, v)) end

local spr = Sprite(N, N, ColorMode.RGB)
local lSil = spr:newLayer()
lSil.name = "silueta"
local lFur = spr:newLayer()
lFur.name = "blana"
local lShd = spr:newLayer()
lShd.name = "umbre"
local lAcc = spr:newLayer()
lAcc.name = "accesorii"

local imgSil = Image(N, N)
local imgFur = Image(N, N)
for yy = 0, N - 1 do
  for xx = 0, N - 1 do
    local k = cls[yy][xx]
    if k ~= "NONE" then
      imgSil:drawPixel(xx, yy, C("e"))
      imgFur:drawPixel(xx, yy, C(k))
    end
  end
end
spr:newCel(lSil, 1, imgSil, Point(0, 0))
spr:newCel(lFur, 1, imgFur, Point(0, 0))

-- Cadrul 2, clipit: aceeasi fata, ochii inchisi. Geometrie explicita, nu
-- din sursa: pupilele si sparkle-ul devin fata, apoi doua linii de pleoape.
local cls2 = {}
for yy = 0, N - 1 do
  cls2[yy] = {}
  for xx = 0, N - 1 do cls2[yy][xx] = cls[yy][xx] end
end
local EYES = { {26, 42, 34}, {52, 68, 60} }
for i = 1, #EYES do
  local x0e, x1e, exc = EYES[i][1], EYES[i][2], EYES[i][3]
  for yy = 22, 38 do
    for xx = x0e, x1e do
      if cls2[yy][xx] == "e" or cls2[yy][xx] == "w" then cls2[yy][xx] = "o" end
    end
  end
  for yy = 30, 31 do
    for xx = exc - 3, exc + 3 do cls2[yy][xx] = "e" end
  end
end
local imgFur2 = Image(N, N)
for yy = 0, N - 1 do
  for xx = 0, N - 1 do
    local k = cls2[yy][xx]
    if k ~= "NONE" then imgFur2:drawPixel(xx, yy, C(k)) end
  end
end
spr:newEmptyFrame()
spr:newCel(lSil, 2, imgSil, Point(0, 0))
spr:newCel(lFur, 2, imgFur2, Point(0, 0))

-- Cadrele 3/4, privit stanga/dreapta: pupilele si sparkle-ul se muta cu 2px,
-- fata ramane aceeasi. Colecteaza intai, sterge, apoi stampileaza mutat.
local function lookFrame(dx)
  local g = {}
  for yy = 0, N - 1 do
    g[yy] = {}
    for xx = 0, N - 1 do g[yy][xx] = cls[yy][xx] end
  end
  local ER = { {26, 42}, {52, 68} }
  for i = 1, #ER do
    local x0e, x1e = ER[i][1], ER[i][2]
    local ink, wht = {}, {}
    for yy = 22, 38 do
      for xx = x0e, x1e do
        local k = g[yy][xx]
        if k == "e" then ink[#ink + 1] = {xx, yy} g[yy][xx] = "o"
        elseif k == "w" then wht[#wht + 1] = {xx, yy} g[yy][xx] = "o" end
      end
    end
    for j = 1, #ink do g[ink[j][2]][ink[j][1] + dx] = "e" end
    for j = 1, #wht do g[wht[j][2]][wht[j][1] + dx] = "w" end
  end
  return g
end
local function imgOf(g)
  local im = Image(N, N)
  for yy = 0, N - 1 do
    for xx = 0, N - 1 do
      if g[yy][xx] ~= "NONE" then im:drawPixel(xx, yy, C(g[yy][xx])) end
    end
  end
  return im
end
spr:newEmptyFrame()
spr:newCel(lSil, 3, imgSil, Point(0, 0))
spr:newCel(lFur, 3, imgOf(lookFrame(-2)), Point(0, 0))
spr:newEmptyFrame()
spr:newCel(lSil, 4, imgSil, Point(0, 0))
spr:newCel(lFur, 4, imgOf(lookFrame(2)), Point(0, 0))

-- Umbrele si accesoriile se deseneaza de mana, pe layerul lor.
-- Sursa n-are umbrire; o umbra automata ar fi inventie, nu fidelitate.

spr.frames[1].duration = 0.160
spr.frames[2].duration = 0.160
spr.frames[3].duration = 0.480
spr.frames[4].duration = 0.480
do local t = spr:newTag(1, 4) t.name = "idle" end
spr:saveAs(OUT)

local fill = massN / ((maxX - minX + 1) * (maxY - minY + 1))
print(string.format("corp=%d,%d %dx%d umplere=%.2f",
  minX, minY, maxX - minX + 1, maxY - minY + 1, fill))
print("OK baza=" .. OUT)
