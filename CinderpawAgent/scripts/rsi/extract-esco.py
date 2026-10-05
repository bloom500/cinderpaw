"""Extract ESCO occupations (released only) from the all-languages RDF dump.

Research data for the AgentLoop field sampler (spec S1.7, global sources).
Usage: python extract-esco.py <esco-vX-classification-rdf.zip> <out.tsv>

Output, one row per (occupation, language) that has a label:
  esco_id  isco  lang  label  description
`isco` is the 4-digit ISCO-08 unit group from the occupation's notation.
The description column is empty when ESCO has none in that language.
Streams the 1.3 GB file; memory stays small.
"""
import sys, zipfile
import xml.etree.ElementTree as ET

RDF = "{http://www.w3.org/1999/02/22-rdf-syntax-ns#}"
XL = "{http://www.w3.org/XML/1998/namespace}lang"
ESCO = "{http://data.europa.eu/esco/model#}"
SKOS = "{http://www.w3.org/2004/02/skos/core#}"
DCT = "{http://purl.org/dc/terms/}"

def clean(s):
    return " ".join((s or "").split())

def main(src, out):
    z = zipfile.ZipFile(src)
    name = next(n for n in z.namelist() if n.endswith(".rdf"))
    rows = 0
    with z.open(name) as f, open(out, "w", encoding="utf-8", newline="\n") as w:
        w.write("esco_id\tisco\tlang\tlabel\tdescription\n")
        for _, el in ET.iterparse(f, events=("end",)):
            about = el.get(RDF + "about", "")
            if not (el.tag == SKOS + "Concept" and "/esco/occupation/" in about):
                continue
            status = next((c.text for c in el if c.tag.endswith("}status")), None)
            notation = next((c.text for c in el if c.tag == SKOS + "notation"), "") or ""
            if status == "released" and notation[:4].isdigit():
                labels = {c.get(XL): clean(c.text) for c in el if c.tag == SKOS + "prefLabel" and c.get(XL)}
                descs = {}
                for d in el.iter(ESCO + "NodeLiteral"):
                    lang = d.findtext(ESCO + "language")
                    text = d.findtext(ESCO + "nodeLiteral")
                    if lang and text:
                        descs[lang] = clean(text)
                esco_id = about.rsplit("/", 1)[1]
                for lang in sorted(labels):
                    w.write("\t".join([esco_id, notation[:4], lang, labels[lang], descs.get(lang, "")]) + "\n")
                    rows += 1
            el.clear()
    print(f"rows {rows}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
