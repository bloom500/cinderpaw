
local spr = Sprite(48, 48)
spr.layers[1].name = "fur"
local skin = spr:newLayer() skin.name = "skin"
local face = spr:newLayer() face.name = "face"
for i, L in ipairs({spr.layers[1], skin, face}) do
  local img = Image{ fromFile = "D:/Cinderpaw Agent/scripts/mascot/v2/layer-" .. L.name .. ".png" }
  spr:newCel(L, 1, img, Point(0, 0))
end
do local t = spr:newTag(1, 1) t.name = "idle" end
spr:saveAs("D:/Cinderpaw Agent/scripts/mascot/v2/cinderpaw-v2.aseprite")
print("ok layers=" .. #spr.layers)
