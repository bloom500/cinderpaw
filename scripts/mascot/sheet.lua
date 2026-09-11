-- sheet.lua: plansa contact cu toate cadrele, compozit blana+accesorii.
local P = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-32.aseprite"
local OUT = "C:/Users/Darius/AppData/Local/Temp/opencode/sheet32.png"
local Z, COLS = 8, 8
local spr = app.open(P)
local named = {}
for _, layer in ipairs(spr.layers) do named[layer.name] = layer end
local NF = #spr.frames
local rows = math.ceil(NF / COLS)
local sheet = Image(32 * COLS * Z, 32 * rows * Z)
local function chan(v)
  return { app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v),
           app.pixelColor.rgbaB(v), app.pixelColor.rgbaA(v) }
end
for f = 1, NF do
  local ox, oy = ((f - 1) % COLS) * 32 * Z, math.floor((f - 1) / COLS) * 32 * Z
  for _, lname in ipairs({ "silueta", "blana", "umbre", "accesorii" }) do
    local layer = named[lname]
    if layer ~= nil then
      local cel = layer:cel(f)
      if cel ~= nil then
        local img = cel.image
        for y = 0, 31 do
          for x = 0, 31 do
            local c = chan(img:getPixel(x, y))
            if c[4] >= 128 then
              local col = app.pixelColor.rgba(c[1], c[2], c[3], 255)
              for dy = 0, Z - 1 do
                for dx = 0, Z - 1 do
                  sheet:drawPixel(ox + x * Z + dx, oy + y * Z + dy, col)
                end
              end
            end
          end
        end
      end
    end
  end
end
sheet:saveAs(OUT)
print("plansa: " .. OUT .. " " .. NF .. " cadre")
app.command.CloseFile()
