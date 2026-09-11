-- patch-bars.lua: porneste de la arta lui Darius, nu de la sursa.
-- 1. Taie barele laterale (x0-7 si x88-95, pline pe toata inaltimea).
-- 2. Reconstruieste cadrele 2-4 (clipit, privit) din baza noua.
-- 3. Salveaza REGRESIV peste cinderpaw-96.aseprite (backup in archive/).
-- Rulare: aseprite.exe -b --script scripts/mascot/patch-bars.lua
local P = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-96.aseprite"
local N = 96
local LETTER = {
  ["1a1a1a"] = "k", ["f28c28"] = "o", ["ffb15e"] = "h",
  ["000000"] = "e", ["ffffff"] = "w",
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

local src = app.open(P)
local got = {}
for _, layer in ipairs(src.layers) do got[layer.name] = layer end
assert(got["blana"] ~= nil, "lipseste blana")
local srcImg = got["blana"]:cel(1).image
assert(srcImg.width == N and srcImg.height == N, "nu e 96")

-- Grila din arta lui, cu barele taiate.
local cls = {}
local cut, strays = 0, 0
for yy = 0, N - 1 do
  cls[yy] = {}
  for xx = 0, N - 1 do
    if xx <= 7 or xx >= 88 then
      local v = srcImg:getPixel(xx, yy)
      if app.pixelColor.rgbaA(v) >= 128 then cut = cut + 1 end
      cls[yy][xx] = "NONE"
    else
      local v = srcImg:getPixel(xx, yy)
      if app.pixelColor.rgbaA(v) < 128 then
        cls[yy][xx] = "NONE"
      else
        local key = string.format("%02x%02x%02x",
          app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v))
        local k = LETTER[key]
        if k == nil then
          strays = strays + 1
          if strays <= 10 then print("strain: " .. key .. " la " .. xx .. "," .. yy) end
          k = "NONE"
        end
        cls[yy][xx] = k
      end
    end
  end
end
-- Resturi de bara: se curata din interior spre exterior, doar ce e desprins
-- de corp (vecinul dinspre corp e gol). Muchia corpului, care atinge corpul,
-- ramane. Bucla merge pana nu se mai schimba nimic.
local rem = 0
for pass = 1, 10 do
  local changed = false
  for yy = 0, N - 1 do
    for _, x in ipairs({ 86, 87 }) do
      if cls[yy][x] ~= "NONE" and cls[yy][x - 1] == "NONE" then
        cls[yy][x] = "NONE"
        rem = rem + 1
        changed = true
      end
    end
    for _, x in ipairs({ 9, 8 }) do
      if cls[yy][x] ~= "NONE" and cls[yy][x + 1] == "NONE" then
        cls[yy][x] = "NONE"
        rem = rem + 1
        changed = true
      end
    end
  end
  if not changed then break end
end
print("taiati din bare: " .. cut .. ", resturi: " .. rem .. ", straini: " .. strays)
assert(strays == 0, "arta contine culori in afara paletei")

local function imgOf(g)
  local im = Image(N, N)
  for yy = 0, N - 1 do
    for xx = 0, N - 1 do
      if g[yy][xx] ~= "NONE" then im:drawPixel(xx, yy, C(g[yy][xx])) end
    end
  end
  return im
end
-- Clipit: sterge e/w din dreptunghiurile ochilor, stampileaza pleoape.
local function blinkOf(base)
  local g = {}
  for yy = 0, N - 1 do
    g[yy] = {}
    for xx = 0, N - 1 do g[yy][xx] = base[yy][xx] end
  end
  local ER = { {26, 42, 34}, {52, 68, 60} }
  for i = 1, #ER do
    local x0e, x1e, exc = ER[i][1], ER[i][2], ER[i][3]
    for yy = 22, 38 do
      for xx = x0e, x1e do
        if g[yy][xx] == "e" or g[yy][xx] == "w" then g[yy][xx] = "o" end
      end
    end
    for yy = 30, 31 do
      for xx = exc - 3, exc + 3 do g[yy][xx] = "e" end
    end
  end
  return g
end
-- Privit: muta e/w cu 2px.
local function lookOf(base, dx)
  local g = {}
  for yy = 0, N - 1 do
    g[yy] = {}
    for xx = 0, N - 1 do g[yy][xx] = base[yy][xx] end
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

local spr = Sprite(N, N, ColorMode.RGB)
local names = { "silueta", "blana", "umbre", "accesorii" }
local layers = {}
for i = 1, #names do
  layers[i] = spr:newLayer()
  layers[i].name = names[i]
end
local function maskOf(g)
  local im = Image(N, N)
  for yy = 0, N - 1 do
    for xx = 0, N - 1 do
      if g[yy][xx] ~= "NONE" then im:drawPixel(xx, yy, C("e")) end
    end
  end
  return im
end
local frames = { cls, blinkOf(cls), lookOf(cls, -2), lookOf(cls, 2) }
while #spr.frames < 4 do spr:newEmptyFrame() end
for f = 1, 4 do
  spr:newCel(layers[1], f, maskOf(frames[f]), Point(0, 0))
  spr:newCel(layers[2], f, imgOf(frames[f]), Point(0, 0))
end
spr.frames[1].duration = 0.160
spr.frames[2].duration = 0.160
spr.frames[3].duration = 0.480
spr.frames[4].duration = 0.480
do local t = spr:newTag(1, 4) t.name = "idle" end
spr:saveAs(P)
print("OK salvat: " .. P)
app.command.CloseFile()
