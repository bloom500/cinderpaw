# Launch Feral in dev mode.
# Tauri runs beforeDevCommand ("cd ../frontend-react && npm run dev") in a
# child shell that doesn't always inherit the user's PATH additions, so we
# prepend the npm/pnpm bin dirs explicitly.
$env:PATH = "C:\Program Files\nodejs;" + [Environment]::GetEnvironmentVariable("PATH","User") + ";" + [Environment]::GetEnvironmentVariable("PATH","Machine")
Set-Location "D:\FeralLocalAI\src-tauri"
& cargo tauri dev
