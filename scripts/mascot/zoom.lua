-- zoom.lua: mareste ultimul export pentru privire, cu pixeli patrati.
local IN = "C:/Users/Darius/AppData/Local/Temp/opencode/vezi.png"
local OUT = "C:/Users/Darius/AppData/Local/Temp/opencode/vezi-mare.png"
local Z = 12
local src = Image{ fromFile = IN }
local big = Image(src.width * Z, src.height * Z)
for y = 0, src.height - 1 do
  for x = 0, src.width - 1 do
    local v = src:getPixel(x, y)
    for dy = 0, Z - 1 do
      for dx = 0, Z - 1 do
        big:drawPixel(x * Z + dx, y * Z + dy, v)
      end
    end
  end
end
big:saveAs(OUT)
print("marit: " .. OUT)
