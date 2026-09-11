"""Verifica mascota canonica. NU deseneaza nimic.

Regula fluxului profesional: scriptul verifica, nu deseneaza.
Desenul se face in Aseprite pe layere (silueta, blana, umbre, accesorii).
Aici doar esuam cu mesaj clar daca baza 96x96 incalca paleta, scala sau contrastul.

  python verify-mascot.py
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PALETTE_PATH = os.path.join(HERE, "palette-12.json")
CANON_96 = os.path.join(HERE, "cinderpaw-96.png")
REF_PATH = os.path.join(HERE, "gemini-96.png")
APP_BACKGROUNDS = ["#100E09", "#1E1E1E"]
# Fisiere cu drept de sedere in radacina; restul PNG-urilor stau in archive/.
RESIDENTS = ("darius-sprite.png", "gemini-96.png", "gemini-576.png",
             "cinderpaw-96.png")


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def luminance(rgb):
    r, g, b = (c / 255.0 for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = luminance(hex_rgb(a)), luminance(hex_rgb(b))
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def fail(msg):
    print("FAIL: " + msg)
    return False


def main():
    ok = True
    if not os.path.exists(REF_PATH):
        ok = fail("lipseste originalul gemini-96.png") and ok
    with open(PALETTE_PATH, encoding="utf-8") as f:
        pal = json.load(f)
    colors = pal["colors"]
    n = sum(1 for v in colors.values() if v is not None)
    if n > 16:
        ok = fail("paleta are %d culori, maxim 16" % n) and ok
    for key in (".", "k", "o", "h", "e", "w"):
        if key not in colors:
            ok = fail("lipseste culoarea '%s' din paleta" % key) and ok
    # Variantele de umbra/lumina exista doar dupa ce sunt desenate de mana.
    if "d" in colors:
        d = hex_rgb(colors["d"])
        if not d[2] > d[0]:
            ok = fail("umbra 'd' nu e shiftata spre albastru (%s)" % colors["d"]) and ok
    if "l" in colors:
        li = hex_rgb(colors["l"])
        if not (li[0] > 200 and li[1] > 150 and li[2] < 140):
            ok = fail("lumina 'l' nu e shiftata spre galben (%s)" % colors["l"]) and ok
    # Contrast fata de fundalul aplicatiei, nu fata de alb.
    for bg in APP_BACKGROUNDS:
        c = contrast(colors["o"], bg)
        if c < 3.0:
            ok = fail("fata 'o' are contrast %.2f fata de %s, minim 3.0" % (c, bg)) and ok
    # PNG-urile generate stau in archive/, nu in radacina.
    strays = [f for f in os.listdir(HERE)
              if f.lower().endswith(".png") and f not in RESIDENTS]
    if strays:
        ok = fail("%d PNG-uri in radacina, muta-le in archive/: %s"
                  % (len(strays), ", ".join(sorted(strays)[:5]))) and ok

    if os.path.exists(CANON_96):
        try:
            from PIL import Image
        except ImportError:
            ok = fail("Pillow lipseste, nu pot verifica cinderpaw-96.png") and ok
        else:
            im = Image.open(CANON_96).convert("RGBA")
            if im.size != (96, 96):
                ok = fail("cinderpaw-96.png e %s, baza unica e 96x96" % (im.size,)) and ok
            allowed = {v.lower() for v in colors.values() if v}
            px = im.load()
            bad = 0
            for y in range(96):
                for x in range(96):
                    r, g, b, a = px[x, y]
                    if a < 128:
                        continue
                    if ("#%02x%02x%02x" % (r, g, b)) not in allowed:
                        bad += 1
            if bad:
                ok = fail("cinderpaw-96.png are %d pixeli in afara paletei" % bad) and ok
            # Fara test de colturi: originalul sangereaza pana in marginea
            # canvasului, deci colturi pline sunt fidelitate, nu defect.
    else:
        print("SKIP: cinderpaw-96.png nu exista inca, se exporta din Aseprite.")

    print("OK: mascota verifica" if ok else "ESUAT: vezi FAIL mai sus")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
