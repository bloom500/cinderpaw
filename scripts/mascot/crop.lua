-- crop.lua: decupeaza si mareste o zona dintr-un cadru, compozit complet.
local P = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-32.aseprite"
local FRAME = 6
local X0, Y0, X1, Y1 = 0, 0, 31, 15
local OUT = "C:/Users/Darius/AppData/Local/Temp/opencode/crop.png"
local Z = 16
local spr = app.open(P)
local named = {}
for _, layer in ipairs(spr.layers) do named[layer.name] = layer end
local function chan(v)
  return { app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v),
           app.pixelColor.rgbaB(v), app.pixelColor.rgbaA(v) }
end
local out = Image((X1 - X0 + 1) * Z, (Y1 - Y0 + 1) * Z)
for _, lname in ipairs({ "silueta", "blana", "umbre", "accesorii" }) do
  local layer = named[lname]
  if layer ~= nil then
    local cel = layer:cel(FRAME)
    if cel ~= nil then
      local img = cel.image
      for y = Y0, Y1 do
        for x = X0, X1 do
          local c = chan(img:getPixel(x, y))
          if c[4] >= 128 then
            local col = app.pixelColor.rgba(c[1], c[2], c[3], 255)
            for dy = 0, Z - 1 do
              for dx = 0, Z - 1 do
                out:drawPixel((x - X0) * Z + dx, (y - Y0) * Z + dy, col)
              end
            end
          end
        end
      end
    end
  end
end
out:saveAs(OUT)
print("decupat: " .. OUT)
app.command.CloseFile()
