-- dump-48.lua: grilele 48 pentru frames.ts. Doar citeste.
local P = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-48.aseprite"
local LETTER = {
  ["1a1a1a"] = "k", ["f28c28"] = "o", ["ffb15e"] = "h",
  ["000000"] = "e", ["ffffff"] = "w",
}
local spr = app.open(P)
local function dump(frame, outpath)
  local img = nil
  for _, layer in ipairs(spr.layers) do
    if layer.name == "blana" then img = layer:cel(frame).image end
  end
  assert(img ~= nil and img.width == 48 and img.height == 48, "blana 48 lipsa")
  local f = io.open(outpath, "w")
  for y = 0, 47 do
    local row = {}
    for x = 0, 47 do
      local v = img:getPixel(x, y)
      if app.pixelColor.rgbaA(v) < 128 then
        row[#row + 1] = "."
      else
        local key = string.format("%02x%02x%02x",
          app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v), app.pixelColor.rgbaB(v))
        local ch = LETTER[key]
        assert(ch ~= nil, "culoare in afara paletei: " .. key)
        row[#row + 1] = ch
      end
    end
    f:write(table.concat(row) .. "\n")
  end
  f:close()
  print("grila scrisa: " .. outpath)
end
dump(1, "D:/Cinderpaw Agent/scripts/mascot/grid-48.txt")
dump(2, "D:/Cinderpaw Agent/scripts/mascot/grid-48-blink.txt")
dump(3, "D:/Cinderpaw Agent/scripts/mascot/grid-48-lookl.txt")
dump(4, "D:/Cinderpaw Agent/scripts/mascot/grid-48-lookr.txt")
app.command.CloseFile()
