-- halve3.lua: 96 -> 32 exact, apoi detalii refacute + 4 cadre de animatie.
-- Votul 3x3 pastreaza masele; sparkle-ul, pleoapele si privirile se construiesc
-- geometric, la scara 32, cu numere masurate din grila (nu ghicite):
-- pupilele stau in x9-13 / x17-22, y7-13, mijlocul la y10.
-- Iesire: scripts/mascot/cinderpaw-32.aseprite (blana+silueta, idle 1-4).
local SRC = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-96.aseprite"
local OUT = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-32.aseprite"
local PRI = { "w", "e", "h", "o", "k" }
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

local src = app.open(SRC)
local srcLayers = {}
for _, layer in ipairs(src.layers) do srcLayers[layer.name] = layer end

local function letterAt(img, x, y)
  local v = img:getPixel(x, y)
  if app.pixelColor.rgbaA(v) < 128 then return "NONE" end
  local key = string.format("%02x%02x%02x",
    app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v))
  local k = HEX[key]
  assert(k ~= nil, "culoare in afara paletei: " .. key)
  return k
end
local function halve(img)
  local g = {}
  for oy = 0, 31 do
    g[oy] = {}
    for ox = 0, 31 do
      local votes = {}
      for dy = 0, 2 do
        for dx = 0, 2 do
          local k = letterAt(img, ox * 3 + dx, oy * 3 + dy)
          votes[k] = (votes[k] or 0) + 1
        end
      end
      if votes["NONE"] == 9 then
        g[oy][ox] = "NONE"
      else
        votes["NONE"] = nil
        local best, bn = "k", -1
        for _, pname in ipairs(PRI) do
          local v = votes[pname] or 0
          if v > bn then bn = v best = pname end
        end
        g[oy][ox] = best
      end
    end
  end
  return g
end
local function copyGrid(g)
  local c = {}
  for yy = 0, 31 do
    c[yy] = {}
    for xx = 0, 31 do c[yy][xx] = g[yy][xx] end
  end
  return c
end

-- Baza, cu sparkle restaurat (votul il pierde mereu): primul pixel de cerneala
-- din fiecare pupila devine alb.
local canon = halve(srcLayers["blana"]:cel(1).image)
local ER = { {9, 13}, {17, 22} }
local spark = 0
for i = 1, #ER do
  for yy = 7, 13 do
    for xx = ER[i][1], ER[i][2] do
      if canon[yy][xx] == "e" then
        canon[yy][xx] = "w"
        spark = spark + 1
        break
      end
    end
    if spark >= i then break end
  end
end
print("sparkle restaurate: " .. spark)
assert(spark == 2, "n-am gasit ambele pupile")

-- Clipit: sterge e/w din ochi, pleoape de 3px la y10.
local function blinkOf(base)
  local g = copyGrid(base)
  for i = 1, #ER do
    for yy = 7, 13 do
      for xx = ER[i][1], ER[i][2] do
        if g[yy][xx] == "e" or g[yy][xx] == "w" then g[yy][xx] = "o" end
      end
    end
    local exc = math.floor((ER[i][1] + ER[i][2]) / 2)
    for xx = exc - 1, exc + 1 do g[10][xx] = "e" end
  end
  return g
end
-- Privit: muta e/w cu 1px, doar pe portocaliu (nu mananca blana).
local function lookOf(base, dx)
  local g = copyGrid(base)
  for i = 1, #ER do
    local ink, wht = {}, {}
    for yy = 7, 13 do
      for xx = ER[i][1], ER[i][2] do
        local k = g[yy][xx]
        if k == "e" then ink[#ink + 1] = {xx, yy} g[yy][xx] = "o"
        elseif k == "w" then wht[#wht + 1] = {xx, yy} g[yy][xx] = "o" end
      end
    end
    for j = 1, #ink do
      local nx = ink[j][1] + dx
      if g[ink[j][2]][nx] == "o" then g[ink[j][2]][nx] = "e" end
    end
    for j = 1, #wht do
      local nx = wht[j][1] + dx
      if g[wht[j][2]][nx] == "o" then g[wht[j][2]][nx] = "w" end
    end
  end
  return g
end

local spr = Sprite(32, 32, ColorMode.RGB)
local lSil = spr:newLayer()
lSil.name = "silueta"
local lFur = spr:newLayer()
lFur.name = "blana"
local frames = { canon, blinkOf(canon), lookOf(canon, -1), lookOf(canon, 1) }
while #spr.frames < 4 do spr:newEmptyFrame() end
for f = 1, 4 do
  local imgSil = Image(32, 32)
  local imgFur = Image(32, 32)
  for yy = 0, 31 do
    for xx = 0, 31 do
      local k = frames[f][yy][xx]
      if k ~= "NONE" then
        imgSil:drawPixel(xx, yy, C("e"))
        imgFur:drawPixel(xx, yy, C(k))
      end
    end
  end
  spr:newCel(lSil, f, imgSil, Point(0, 0))
  spr:newCel(lFur, f, imgFur, Point(0, 0))
end
spr.frames[1].duration = 0.160
spr.frames[2].duration = 0.160
spr.frames[3].duration = 0.480
spr.frames[4].duration = 0.480
do local t = spr:newTag(1, 4) t.name = "idle" end
spr:saveAs(OUT)
print("OK baza 32: " .. OUT)
app.command.CloseFile()
