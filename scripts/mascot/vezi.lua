-- vezi.lua: exporta ce vede Aseprite, ca sa vad si eu. Cadru + strat la alegere.
local P = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-32.aseprite"
local OUT = "C:/Users/Darius/AppData/Local/Temp/opencode/vezi.png"
local FRAME = 1
local LAYERS = { "silueta", "blana", "umbre", "accesorii" }
local spr = app.open(P)
local W, H = spr.width, spr.height
local named = {}
for _, layer in ipairs(spr.layers) do named[layer.name] = layer end
local function chan(v)
  return { app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v),
           app.pixelColor.rgbaB(v), app.pixelColor.rgbaA(v) }
end
local out = Image(W, H)
for y = 0, H - 1 do
  for x = 0, W - 1 do
    local dr, dg, db, da = 0, 0, 0, 0
    for i = 1, #LAYERS do
      local layer = named[LAYERS[i]]
      if layer ~= nil then
        local cel = layer:cel(FRAME)
        if cel ~= nil then
          local img = cel.image
          if x < img.width and y < img.height then
            local c = chan(img:getPixel(x, y))
            local sa = c[4] / 255
            dr = c[1] * sa + dr * (1 - sa)
            dg = c[2] * sa + dg * (1 - sa)
            db = c[3] * sa + db * (1 - sa)
            da = sa + da * (1 - sa)
          end
        end
      end
    end
    out:drawPixel(x, y, app.pixelColor.rgba(
      math.floor(dr + 0.5), math.floor(dg + 0.5), math.floor(db + 0.5),
      math.floor(da * 255 + 0.5)))
  end
end
out:saveAs(OUT)
print("exportat: " .. OUT .. " cadru " .. FRAME)
app.command.CloseFile()
