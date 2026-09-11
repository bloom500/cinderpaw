-- verify-final.lua: audit independent al livrabilului, din fisier.
-- 23 taguri cu nume exacte, fiecare cu >=1 cadru, paleta exact 5 culori.
local P = "D:/Cinderpaw Agent/scripts/mascot/cinderpaw-32.aseprite"
local WANT = { "idle", "typing", "thinking", "calling", "done", "running",
  "wave", "sleep", "surprised", "curious", "celebrate", "reading",
  "searching", "building", "writing", "stretching", "gaming", "love",
  "cool", "error", "excited", "spawning", "meditating" }
local spr = app.open(P)
local ok = true
local have = {}
for _, t in ipairs(spr.tags) do
  have[t.name] = true
  local n = t.toFrame.frameNumber - t.fromFrame.frameNumber + 1
  if n < 1 then ok = false print("TAG GOL: " .. t.name) end
end
for i = 1, #WANT do
  if not have[WANT[i]] then ok = false print("TAG LIPSA: " .. WANT[i]) end
end
print("taguri gasite: " .. #spr.tags .. " (asteptat 23)")
local cols = {}
for _, layer in ipairs(spr.layers) do
  if layer.name == "blana" or layer.name == "accesorii" then
    for f = 1, #spr.frames do
      local cel = layer:cel(f)
      if cel ~= nil then
        local img = cel.image
        for y = 0, img.height - 1 do
          for x = 0, img.width - 1 do
            local v = img:getPixel(x, y)
            if app.pixelColor.rgbaA(v) >= 128 then
              cols[string.format("%02x%02x%02x",
                app.pixelColor.rgbaR(v), app.pixelColor.rgbaG(v),
                app.pixelColor.rgbaB(v))] = true
            end
          end
        end
      end
    end
  end
end
local list = {}
for k, _ in pairs(cols) do list[#list + 1] = k end
table.sort(list)
print("paleta: " .. table.concat(list, ",") .. " (" .. #list .. " culori)")
if #list ~= 5 then ok = false end
print(ok and "VERDICT: GATA" or "VERDICT: RESPINS")
app.command.CloseFile()
