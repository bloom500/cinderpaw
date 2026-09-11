-- halve.lua: 96 -> 48 exact (fiecare 2x2 devine 1px), in Aseprite.
-- Blocurile unanime isi pastreaza culoarea. La egalitate castiga detaliul
-- luminos (sparkle, ochi, coarne, fata, blana): ce e mic si luminos trebuie
-- sa supravietuiasca injumatatirii, nu masa. Dupa rulare se verifica vizual
-- si se corecteaza de mana ce iese stramb.
-- Iesire: scripts/mascot/cinderpaw-48.aseprite (blana+silueta, 4 cadre).
local SRC = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-96.aseprite"
local OUT = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-48.aseprite"
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
local NF = #src.frames
print("cadre sursa: " .. NF)

local function letterAt(img, x, y)
  local v = img:getPixel(x, y)
  if app.pixelColor.rgbaA(v) < 128 then return "NONE" end
  local key = string.format("%02x%02x%02x",
    app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v))
  local k = HEX[key]
  assert(k ~= nil, "culoare in afara paletei: " .. key)
  return k
end
-- Injumatatire cu prioritati. Intoarce grila de litere 48x48.
local function halve(img)
  local g = {}
  for oy = 0, 47 do
    g[oy] = {}
    for ox = 0, 47 do
      local votes = {}
      for dy = 0, 1 do
        for dx = 0, 1 do
          local k = letterAt(img, ox * 2 + dx, oy * 2 + dy)
          votes[k] = (votes[k] or 0) + 1
        end
      end
      if votes["NONE"] == 4 then
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

local spr = Sprite(48, 48, ColorMode.RGB)
local lSil = spr:newLayer()
lSil.name = "silueta"
local lFur = spr:newLayer()
lFur.name = "blana"
while #spr.frames < NF do spr:newEmptyFrame() end
for f = 1, NF do
  local g = halve(srcLayers["blana"]:cel(f).image)
  local imgSil = Image(48, 48)
  local imgFur = Image(48, 48)
  for yy = 0, 47 do
    for xx = 0, 47 do
      if g[yy][xx] ~= "NONE" then
        imgSil:drawPixel(xx, yy, C("e"))
        imgFur:drawPixel(xx, yy, C(g[yy][xx]))
      end
    end
  end
  spr:newCel(lSil, f, imgSil, Point(0, 0))
  spr:newCel(lFur, f, imgFur, Point(0, 0))
  spr.frames[f].duration = src.frames[f].duration
end
for _, tag in ipairs(src.tags) do
  local t = spr:newTag(tag.fromFrame.frameNumber, tag.toFrame.frameNumber)
  t.name = tag.name
end
spr:saveAs(OUT)
print("OK injumatatit: " .. OUT)
app.command.CloseFile()
